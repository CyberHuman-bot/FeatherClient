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
    if (address.startsWith('127.')) return true;
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
    maxContentLength: 5 * 1024 * 1024 // 5MB cap
};

const MAX_REDIRECTS = 5;

// Fetches a URL, following redirects MANUALLY so every hop is SSRF-checked
// (a public URL could otherwise 302 to http://127.0.0.1/ or a metadata
// endpoint). Also returns the final URL, which is the correct base for
// resolving relative links after any redirect.
async function fetchSafe(url, { method = 'get', data = null } = {}) {
    let currentUrl = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        if (!(await isSafeUrl(currentUrl))) throw new Error('URL not allowed');

        const headers = { ...FETCH_OPTS.headers };
        if (data) headers['Content-Type'] = 'application/x-www-form-urlencoded';

        const response = await axios({
            ...FETCH_OPTS,
            url: currentUrl,
            method,
            data,
            headers,
            maxRedirects: 0,
            validateStatus: status => status >= 200 && status < 400
        });

        if (response.status >= 300 && response.headers.location) {
            currentUrl = new URL(response.headers.location, currentUrl).href;
            method = 'get'; // browsers turn POST redirects into GET
            data = null;
            continue;
        }
        return { response, finalUrl: currentUrl };
    }
    throw new Error('Too many redirects');
}

const INLINE_SCRIPT_MAX_BYTES = 2000; // keep only small, likely-simple inline scripts

function escapeHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

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
// page's real URL before the content is sent out. Without this the
// browser resolves paths like "/images/logo.png" or "//host/x.png"
// against localhost:3000 (the proxy), which causes "Cannot GET /images/..."
// ==========================================
const SKIP_URL = /^(data:|javascript:|mailto:|tel:|#)/i;

function absolutize(raw, baseUrl) {
    if (!raw || SKIP_URL.test(raw.trim())) return null;
    try { return new URL(raw.trim(), baseUrl).href; } catch { return null; }
}

// DuckDuckGo wraps result links as https://duckduckgo.com/l/?uddg=<real url>.
// Unwrap them so a click goes straight to the real destination through
// the proxy instead of bouncing through DDG's redirector.
function unwrapRedirect(href) {
    try {
        const u = new URL(href);
        if (/(^|\.)duckduckgo\.com$/i.test(u.hostname) && u.pathname.startsWith('/l/')) {
            const target = u.searchParams.get('uddg');
            if (target && /^https?:/i.test(target)) return target;
        }
    } catch { /* not a URL we can unwrap */ }
    return href;
}

function resolveResourceUrls(document, baseUrl) {
    // new URL(raw, base) covers root-relative ("/x.png"), protocol-relative
    // ("//host/x.png") and path-relative ("x.png") forms.
    document.querySelectorAll('img, source, video, audio, embed').forEach(el => {
        const abs = absolutize(el.getAttribute('src'), baseUrl);
        if (abs) el.setAttribute('src', abs);

        // Lazy-loaded images often keep the real URL in data-src
        if (!abs) {
            const lazy = absolutize(el.getAttribute('data-src'), baseUrl);
            if (lazy) el.setAttribute('src', lazy);
        }
    });

    // srcset holds several URL/size pairs; feature phones gain nothing from
    // responsive variants, so drop it and rely on the resolved src.
    document.querySelectorAll('[srcset]').forEach(el => el.removeAttribute('srcset'));

    document.querySelectorAll('a[href], area[href]').forEach(a => {
        const abs = absolutize(a.getAttribute('href'), baseUrl);
        if (abs) a.setAttribute('href', unwrapRedirect(abs));
    });

    // A <meta http-equiv="refresh"> would send the browser straight to the
    // real site (or a relative path on localhost); remove it.
    document.querySelectorAll('meta[http-equiv="refresh" i]').forEach(m => m.remove());
}

// ==========================================
// DOCUMENT REWRITE
// Makes a fetched page safe and keeps the user inside the proxy:
//  - resource URLs become absolute
//  - inline event handlers and javascript: links are removed (the page is
//    injected into our own origin, so they must not run)
//  - every link points back at /render?url=... (data-fn-url holds the
//    real URL so the client can load it via AJAX instead)
//  - every form submits via GET to /render, carrying the original action
//    and method in hidden fields, so POST forms (e.g. "Next Page") work
// ==========================================
function rewriteDocument(document, pageUrl, ownOrigin) {
    resolveResourceUrls(document, pageUrl);

    // Strip inline handlers and javascript: URLs
    document.querySelectorAll('*').forEach(el => {
        Array.from(el.attributes).forEach(attr => {
            if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
        });
    });
    document.querySelectorAll('[href^="javascript:" i]').forEach(el => el.removeAttribute('href'));

    // Route audio through the audio proxy (src is already absolute)
    document.querySelectorAll('audio, audio source').forEach(audio => {
        const src = audio.getAttribute('src');
        if (src && /^https?:/i.test(src)) {
            audio.setAttribute('src', `${ownOrigin}/audio-proxy?url=${encodeURIComponent(src)}`);
        }
    });

    // Links stay inside the proxy
    document.querySelectorAll('a[href]').forEach(a => {
        const href = a.getAttribute('href');
        if (!/^https?:/i.test(href)) return;
        a.setAttribute('data-fn-url', href);
        a.setAttribute('href', `${ownOrigin}/render?url=${encodeURIComponent(href)}`);
        a.removeAttribute('target');
    });

    // Forms stay inside the proxy
    document.querySelectorAll('form').forEach(form => {
        const rawAction = form.getAttribute('action');
        const action = (rawAction && absolutize(rawAction, pageUrl)) || pageUrl;
        const method = (form.getAttribute('method') || 'get').toLowerCase() === 'post' ? 'post' : 'get';

        form.setAttribute('method', 'get');
        form.setAttribute('action', `${ownOrigin}/render`);
        form.removeAttribute('enctype');
        form.removeAttribute('target');

        [['__fn_action', action], ['__fn_method', method]].forEach(([name, value]) => {
            const input = document.createElement('input');
            input.type = 'hidden';
            input.name = name;
            input.value = value;
            form.appendChild(input);
        });
    });
}

// ==========================================
// ROOT ROUTE (Web Client Fallback)
// ==========================================
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Works out what to fetch from the query string. Supports a plain URL /
// search term, or a rewritten form submission (__fn_action + __fn_method
// + the form's own fields).
function buildRequest(query) {
    if (query.__fn_action) {
        const action = String(query.__fn_action);
        const method = String(query.__fn_method || 'get').toLowerCase() === 'post' ? 'post' : 'get';

        const fields = new URLSearchParams();
        for (const [key, value] of Object.entries(query)) {
            if (key.startsWith('__fn_') || key === 'fragment') continue;
            (Array.isArray(value) ? value : [value]).forEach(v => fields.append(key, String(v)));
        }

        if (method === 'post') {
            return { targetUrl: action, method, body: fields.toString() };
        }
        const u = new URL(action); // throws on garbage; caller handles
        fields.forEach((v, k) => u.searchParams.set(k, v));
        return { targetUrl: u.href, method, body: null };
    }

    const target = query.url || query.q || query.search;
    if (!target) return null;
    return { targetUrl: resolveTargetUrl(String(target)), method: 'get', body: null };
}

// ==========================================
// CORE RENDER / SEARCH LOGIC
// ==========================================
async function handleRender(req, res) {
    const isFragment = req.query.fragment === '1';

    let request;
    try {
        request = buildRequest(req.query);
    } catch {
        return res.status(400).send('FeatherNet Proxy Error: bad request');
    }
    if (!request) {
        return res.redirect('/');
    }

    const { targetUrl, method, body } = request;

    if (!(await isSafeUrl(targetUrl))) {
        return res.status(400).send('FeatherNet Proxy Error: URL not allowed');
    }

    try {
        const { response, finalUrl } = await fetchSafe(targetUrl, { method, data: body });

        // Opening an image (or other non-HTML file) directly: don't feed it
        // to the HTML parser. Show images inline, link anything else.
        const contentType = String(response.headers['content-type'] || '').toLowerCase();
        if (contentType && !/html|xml/.test(contentType)) {
            const safe = escapeHtml(finalUrl);
            const inner = contentType.startsWith('image/')
                ? `<img src="${safe}" style="max-width:100%">`
                : `<a href="${safe}">Download file</a>`;
            res.setHeader('Content-Type', 'text/html');
            return res.send(`<div class="fn-frag">${inner}</div>`);
        }

        // No script execution / external resource loading during parse:
        // faster, and avoids running untrusted page JS server-side.
        const dom = new JSDOM(response.data, { url: finalUrl });
        const document = dom.window.document;

        const ownOrigin = `${req.protocol}://${req.get('host')}`;
        rewriteDocument(document, finalUrl, ownOrigin);

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

        const title = escapeHtml(document.title || 'FeatherNet Page');

        if (isFragment) {
            // AJAX-loaded fragment: NO <style> block. A <style> tag applies
            // to the whole real document no matter where it's injected via
            // innerHTML, so page-level rules here would leak out and clobber
            // the client shell's own theme. Scope everything to a wrapper
            // class instead and let the client's own CSS handle presentation.
            const fragmentHtml = `<div class="fn-frag">
    <div class="fn-title">FeatherNet: ${title}</div>
    ${document.body.innerHTML}
    ${scriptTag}
</div>`;
            res.setHeader('Content-Type', 'text/html');
            return res.send(fragmentHtml);
        }

        // Full standalone page (used when the client's JS isn't running,
        // e.g. basic feature-phone browsers). Dark theme to match the shell,
        // plus its own search bar so the user is never stranded.
        const cleanHtml = `<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
    <style>
        body { font-family: sans-serif; padding: 6px; background: #121212; color: #e0e0e0; margin: 0; }
        a { color: #4da6ff; text-decoration: underline; display: inline-block; margin: 2px 0; }
        audio { width: 100%; margin: 6px 0; }
        img { max-width: 100%; height: auto; }
        div, p, table, td, tr, header, section { max-width: 100%; box-sizing: border-box; }
        input, select, button { background: #1e1e1e; color: #e0e0e0; border: 1px solid #444; font-family: monospace; }
        .fn-bar { display: flex; gap: 4px; margin-bottom: 6px; }
        .fn-bar input[type="text"] { flex: 1; padding: 8px; color: #55ff55; }
        .fn-bar button { padding: 8px 12px; background: #0066cc; color: #fff; border: none; font-weight: bold; }
        .fn-title { background: #223322; padding: 4px; text-align: center; font-weight: bold; margin-bottom: 8px; }
    </style>
</head>
<body>
    <form action="${escapeHtml(ownOrigin)}/search" method="get" class="fn-bar">
        <input type="text" name="q" value="" placeholder="URL or Search..." required>
        <button type="submit">GO</button>
    </form>
    <div class="fn-title">FeatherNet: ${title}</div>
    ${document.body.innerHTML}
    ${scriptTag}
</body>
</html>`;

        res.setHeader('Content-Type', 'text/html');
        res.send(cleanHtml);

    } catch (err) {
        const status = err.message === 'URL not allowed' ? 400 : 500;
        res.status(status).send(`FeatherNet Proxy Error: ${escapeHtml(err.message)}`);
    }
}

app.get('/search', handleRender);
app.get('/render', handleRender);

// ==========================================
// JSON API ENDPOINT (For Native Clients)
// ==========================================
app.get('/api/v1/page', async (req, res) => {
    const target = req.query.url || req.query.q || req.query.search;
    if (!target) {
        return res.status(400).json({ error: 'Missing url parameter' });
    }

    const targetUrl = resolveTargetUrl(String(target));

    if (!(await isSafeUrl(targetUrl))) {
        return res.status(400).json({ error: 'URL not allowed' });
    }

    try {
        const { response, finalUrl } = await fetchSafe(targetUrl);
        const dom = new JSDOM(response.data, { url: finalUrl });
        const document = dom.window.document;
        resolveResourceUrls(document, finalUrl);

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
        const status = err.message === 'URL not allowed' ? 400 : 500;
        res.status(status).json({ error: err.message });
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

    if (!(await isSafeUrl(String(audioUrl)))) {
        return res.status(400).send('Error: URL not allowed');
    }

    res.setHeader('Content-Type', 'audio/aac');
    res.setHeader('Transfer-Encoding', 'chunked');

    ffmpeg(String(audioUrl))
        // Only network protocols: stops playlists from pulling in local files
        .inputOptions(['-protocol_whitelist', 'http,https,tcp,tls,crypto'])
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

module.exports = { app, rewriteDocument, unwrapRedirect, absolutize, buildRequest };

// Start Server (only when run directly, so tests can require this file)
if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`FeatherNet Server running on http://localhost:${PORT}`);
    });
}
