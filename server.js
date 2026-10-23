const express = require('express');
const axios = require('axios');
const { JSDOM } = require('jsdom');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const path = require('path');
const dns = require('dns').promises;
const net = require('net');
const { minify } = require('terser');

// Configure ffmpeg binary path
ffmpeg.setFfmpegPath(ffmpegPath);

// Initialize Express App
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware & Static File Serving
app.use(express.json());
app.use(express.static('public')); // Serves public/index.html

// ==========================================
// SSRF PROTECTION
// Blocks requests to loopback / private / link-local addresses,
// including via DNS rebinding, so the server can't be used as an
// open proxy into internal networks or cloud metadata endpoints.
// ==========================================
function isBlockedIp(address) {
    if (address === '127.0.0.1' || address === '::1' || address === '0.0.0.0') return true;
    if (address.startsWith('10.')) return true;
    if (address.startsWith('192.168.')) return true;
    if (address.startsWith('169.254.')) return true; // link-local + cloud metadata
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) return true;
    if (address.startsWith('fc') || address.startsWith('fd')) return true; // IPv6 ULA
    if (address.startsWith('fe80:')) return true; // IPv6 link-local
    return false;
}

async function isSafeUrl(rawUrl) {
    let parsed;
    try { parsed = new URL(rawUrl); } catch { return false; }
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;

    let addresses;
    try {
        addresses = await dns.lookup(parsed.hostname, { all: true });
    } catch {
        return false;
    }
    if (addresses.length === 0) return false;

    for (const { address } of addresses) {
        if (net.isIP(address) && isBlockedIp(address)) return false;
    }
    return true;
}

// Shared axios config: bounded timeout + response size cap so a slow
// or huge upstream can't hang a request or blow up memory.
const FETCH_OPTS = {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
    timeout: 8000,
    maxContentLength: 5 * 1024 * 1024, // 5MB cap
    maxRedirects: 5
};

const INLINE_SCRIPT_MAX_BYTES = 2000; // keep only small, likely-simple inline scripts

// Helper function to extract and preserve background color and alignment
function extractEssentialStyles(el) {
    let styles = [];

    const inlineStyle = el.getAttribute('style') || '';

    const bgMatch = inlineStyle.match(/background(?:-color)?\s*:\s*([^;]+)/i);
    if (bgMatch) styles.push(`background-color:${bgMatch[1].trim()}`);

    const alignMatch = inlineStyle.match(/text-align\s*:\s*([^;]+)/i);
    if (alignMatch) styles.push(`text-align:${alignMatch[1].trim()}`);

    const legacyAlign = el.getAttribute('align');
    if (legacyAlign && !alignMatch) {
        styles.push(`text-align:${legacyAlign.toLowerCase()}`);
    }

    const legacyBg = el.getAttribute('bgcolor');
    if (legacyBg && !bgMatch) {
        styles.push(`background-color:${legacyBg}`);
    }

    return styles.length > 0 ? styles.join(';') : null;
}

// ==========================================
// JS RETENTION: keep small inline scripts, minify them, drop everything
// else (external bundles, frameworks, analytics). Feature-phone JS
// engines can't run heavy bundles regardless of minification, so this
// keeps only content that has a real chance of running.
// ==========================================
async function collectMinifiedInlineScripts(document) {
    const scripts = document.querySelectorAll('script:not([src])');
    const kept = [];

    for (const script of scripts) {
        const code = script.textContent || '';
        if (!code.trim()) continue;
        if (Buffer.byteLength(code, 'utf8') > INLINE_SCRIPT_MAX_BYTES) continue;

        try {
            const result = await minify(code, {
                ecma: 5,           // widest feature-phone compatibility
                compress: true,
                mangle: true
            });
            if (result.code) kept.push(result.code);
        } catch {
            // If it doesn't parse/minify cleanly, skip it rather than
            // shipping broken JS to a constrained client.
        }
    }

    return kept;
}

function resolveTargetUrl(target) {
    target = target.trim();
    if (target.startsWith('http://') || target.startsWith('https://')) {
        return target;
    } else if (target.includes('.') && !target.includes(' ')) {
        return 'https://' + target;
    }
    return `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(target)}`;
}

// ==========================================
// RESOURCE URL RESOLUTION
// Rewrites every relative src/href to an absolute URL against the
// page's real origin before the content is sent out. Without this the
// browser resolves paths like "/images/logo.png" or "//host/x.png"
// against localhost:3000 (the proxy), which causes "Cannot GET /images/..."
// and links that land on localhost:3000/api/... instead of the real site.
// Explicit rewriting also replaces the <base> tag, which would hijack the
// client shell's own fetch('/search?...') calls when injected as a fragment.
// ==========================================
const SKIP_URL = /^(data:|javascript:|mailto:|tel:|#)/i;

function absolutize(raw, targetUrl) {
    if (!raw || SKIP_URL.test(raw.trim())) return null;
    try { return new URL(raw.trim(), targetUrl).href; } catch { return null; }
}

function resolveResourceUrls(document, targetUrl) {
    // new URL(raw, base) covers root-relative ("/x.png"), protocol-relative
    // ("//host/x.png") and path-relative ("x.png") forms.
    document.querySelectorAll('img, source, video, audio, embed').forEach(el => {
        const abs = absolutize(el.getAttribute('src'), targetUrl);
        if (abs) el.setAttribute('src', abs);

        // Lazy-loaded images often keep the real URL in data-src
        if (!abs) {
            const lazy = absolutize(el.getAttribute('data-src'), targetUrl);
            if (lazy) el.setAttribute('src', lazy);
        }
    });

    // srcset holds several URL/size pairs; feature phones gain nothing from
    // responsive variants, so drop it and rely on the resolved src.
    document.querySelectorAll('[srcset]').forEach(el => el.removeAttribute('srcset'));

    document.querySelectorAll('a[href], area[href]').forEach(a => {
        const abs = absolutize(a.getAttribute('href'), targetUrl);
        if (abs) a.setAttribute('href', abs);
    });

    // A <meta http-equiv="refresh"> would send the browser to a relative
    // path on localhost; remove it.
    document.querySelectorAll('meta[http-equiv="refresh" i]').forEach(m => m.remove());
}

// ==========================================
// ROOT ROUTE (Web Client Fallback)
// ==========================================
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ==========================================
// CORE RENDER / SEARCH LOGIC
// ==========================================
async function handleRender(req, res) {
    let target = req.query.url || req.query.q || req.query.search;
    if (!target) {
        return res.redirect('/');
    }

    const targetUrl = resolveTargetUrl(target);
    const isFragment = req.query.fragment === '1';

    if (!(await isSafeUrl(targetUrl))) {
        return res.status(400).send('FeatherNet Proxy Error: URL not allowed');
    }

    try {
        const response = await axios.get(targetUrl, FETCH_OPTS);

        // Opening an image (or other non-HTML file) directly: don't feed it
        // to the HTML parser. Show images inline, link anything else.
        const contentType = String(response.headers['content-type'] || '').toLowerCase();
        if (contentType && !/html|xml/.test(contentType)) {
            const safe = targetUrl.replace(/"/g, '&quot;');
            const body = contentType.startsWith('image/')
                ? `<img src="${safe}" style="max-width:100%">`
                : `<a href="${safe}">Download file</a>`;
            res.setHeader('Content-Type', 'text/html');
            return res.send(`<div class="fn-frag">${body}</div>`);
        }

        // No script execution / external resource loading during parse:
        // faster, and avoids running untrusted page JS server-side.
        const dom = new JSDOM(response.data, { url: targetUrl });
        const document = dom.window.document;

        // Make every relative resource/link URL absolute before anything
        // else touches the DOM (see resolveResourceUrls above for why).
        resolveResourceUrls(document, targetUrl);

        // Route audio through the audio proxy. src is already absolute
        // here, and the proxy URL is absolute to our own origin.
        const ownOrigin = `${req.protocol}://${req.get('host')}`;
        document.querySelectorAll('audio, audio source').forEach(audio => {
            const rawSrc = audio.getAttribute('src');
            if (rawSrc) {
                audio.setAttribute('src', `${ownOrigin}/audio-proxy?url=${encodeURIComponent(rawSrc)}`);
            }
        });

        // Rewrite forms (e.g. DDG Lite's search box, which POSTs) to GET
        // against our own /search route. Original field names (like "q")
        // are kept, so the existing target-resolution logic in
        // resolveTargetUrl() picks them up automatically. This is a
        // simple fix aimed at search boxes; multi-field forms like
        // logins won't function correctly through it.
        document.querySelectorAll('form').forEach(form => {
            form.setAttribute('method', 'get');
            form.setAttribute('action', `${ownOrigin}/search`);
        });

        // Preserve essential styles (alignments & bg colors)
        document.querySelectorAll('body *').forEach(el => {
            const preserved = extractEssentialStyles(el);
            if (preserved) {
                el.setAttribute('style', preserved);
            } else {
                el.removeAttribute('style');
            }
            el.removeAttribute('align');
            el.removeAttribute('bgcolor');
        });

        // Keep small inline scripts (minified); strip everything else heavy
        const minifiedScripts = await collectMinifiedInlineScripts(document);

        const clutter = document.querySelectorAll('script, style, iframe, svg, canvas, link[rel="stylesheet"]');
        clutter.forEach(el => el.remove());

        const scriptTag = minifiedScripts.length
            ? `<script>${minifiedScripts.join(';')}</script>`
            : '';

        if (isFragment) {
            // AJAX-loaded fragment: NO <style> block. A <style> tag applies
            // to the whole real document no matter where it's injected via
            // innerHTML, so page-level rules here would leak out and clobber
            // the client shell's own theme. Scope everything to a wrapper
            // class instead and let the client's own CSS (targeting
            // #viewport a, #viewport audio, etc.) handle presentation.
            const fragmentHtml = `<div class="fn-frag">
    <div class="fn-title">FeatherNet: ${document.title}</div>
    ${document.body.innerHTML}
    ${scriptTag}
</div>`;
            res.setHeader('Content-Type', 'text/html');
            return res.send(fragmentHtml);
        }

        const cleanHtml = `<!DOCTYPE html>
<html>
<head>
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${document.title || 'FeatherNet Page'}</title>
    <style>
        body { font-family: sans-serif; padding: 6px; background: #ffffff; color: #111111; margin: 0; }
        a { color: #0066cc; text-decoration: none; display: inline-block; margin: 2px 0; }
        audio { width: 100%; margin: 6px 0; }
        div, p, table, td, tr, header, section { max-width: 100%; box-sizing: border-box; }
    </style>
</head>
<body>
    <div style="background-color:#eee; padding:4px; text-align:center; font-weight:bold; margin-bottom:8px;">
        FeatherNet: ${document.title}
    </div>
    ${document.body.innerHTML}
    ${scriptTag}
</body>
</html>`;

        res.setHeader('Content-Type', 'text/html');
        res.send(cleanHtml);

    } catch (err) {
        res.status(500).send(`FeatherNet Proxy Error: ${err.message}`);
    }
}

app.get('/search', handleRender);
app.get('/render', handleRender);

// ==========================================
// JSON API ENDPOINT (For Native Clients)
// ==========================================
app.get('/api/v1/page', async (req, res) => {
    let target = req.query.url || req.query.q || req.query.search;
    if (!target) {
        return res.status(400).json({ error: 'Missing url parameter' });
    }

    const targetUrl = resolveTargetUrl(target);

    if (!(await isSafeUrl(targetUrl))) {
        return res.status(400).json({ error: 'URL not allowed' });
    }

    try {
        const response = await axios.get(targetUrl, FETCH_OPTS);
        const dom = new JSDOM(response.data, { url: targetUrl });
        const document = dom.window.document;
        resolveResourceUrls(document, targetUrl);

        const links = [];
        document.querySelectorAll('a[href]').forEach((a, i) => {
            links.push({
                id: i + 1,
                text: a.textContent.trim(),
                href: a.getAttribute('href')
            });
        });

        const blocks = [];
        document.querySelectorAll('p, h1, h2, h3, h4, li, div').forEach(el => {
            const style = extractEssentialStyles(el);
            if (el.textContent.trim().length > 0) {
                blocks.push({
                    tag: el.tagName.toLowerCase(),
                    text: el.textContent.trim(),
                    style: style
                });
            }
        });

        const scripts = await collectMinifiedInlineScripts(document);

        res.json({
            title: document.title || 'FeatherNet Page',
            blocks: blocks,
            links: links,
            scripts: scripts
        });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// LOW-BANDWIDTH AUDIO STREAM PROXY
// ==========================================
app.get('/audio-proxy', async (req, res) => {
    const audioUrl = req.query.url;

    if (!audioUrl) {
        return res.status(400).send('Error: Missing audio url');
    }

    if (!(await isSafeUrl(audioUrl))) {
        return res.status(400).send('Error: URL not allowed');
    }

    res.setHeader('Content-Type', 'audio/aac');
    res.setHeader('Transfer-Encoding', 'chunked');

    ffmpeg(audioUrl)
        .audioCodec('aac')
        .audioBitrate('32k')
        .audioChannels(1)
        .format('adts')
        .on('error', (err) => {
            console.error('Audio Transcoding Error:', err.message);
            if (!res.headersSent) res.status(500).send('Audio stream error');
        })
        .pipe(res, { end: true });
});

// Start Server
app.listen(PORT, () => {
    console.log(`FeatherNet Server running on http://localhost:${PORT}`);
});
