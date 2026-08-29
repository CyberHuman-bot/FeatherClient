const express = require('express');
const axios = require('axios');
const { JSDOM } = require('jsdom');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const path = require('path');

// Configure ffmpeg binary path
ffmpeg.setFfmpegPath(ffmpegPath);

// Initialize Express App
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware & Static File Serving
app.use(express.json());
app.use(express.static('public')); // Serves public/index.html

// Helper function to extract and preserve background color and alignment
function extractEssentialStyles(el) {
    let styles = [];

    // 1. Check existing inline styles
    const inlineStyle = el.getAttribute('style') || '';
    
    // Extract background-color or background
    const bgMatch = inlineStyle.match(/background(?:-color)?\s*:\s*([^;]+)/i);
    if (bgMatch) styles.push(`background-color:${bgMatch[1].trim()}`);

    // Extract text-align
    const alignMatch = inlineStyle.match(/text-align\s*:\s*([^;]+)/i);
    if (alignMatch) styles.push(`text-align:${alignMatch[1].trim()}`);

    // 2. Check legacy HTML attributes
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
// ROOT ROUTE (Web Client Fallback)
// ==========================================
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ==========================================
// SEARCH ROUTE HANDLER (Browser Input Route)
// ==========================================
app.get('/search', (req, res) => {
    let query = req.query.url || req.query.q || req.query.search;

    if (!query) {
        return res.redirect('/');
    }

    query = query.trim();

    // Check if input is a direct URL or search query
    let targetUrl;
    if (query.startsWith('http://') || query.startsWith('https://')) {
        targetUrl = query;
    } else if (query.includes('.') && !query.includes(' ')) {
        targetUrl = 'https://' + query;
    } else {
        // Direct plain text queries to DuckDuckGo HTML Lite
        targetUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    }

    res.redirect(`/render?url=${encodeURIComponent(targetUrl)}`);
});

// ==========================================
// 1. HTML COMPRESSOR RENDERER
// ==========================================
app.get('/render', async (req, res) => {
    const targetUrl = req.query.url;

    if (!targetUrl) {
        return res.status(400).send('Error: Missing url parameter');
    }

    try {
        const response = await axios.get(targetUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
        });

        const dom = new JSDOM(response.data, {
            url: targetUrl,
            runScripts: "dangerously",
            resources: "usable"
        });

        setTimeout(() => {
            const document = dom.window.document;

            // Route audio elements through audio proxy
            const audioElements = document.querySelectorAll('audio, audio source');
            audioElements.forEach(audio => {
                const rawSrc = audio.getAttribute('src');
                if (rawSrc) {
                    const absoluteUrl = new URL(rawSrc, targetUrl).href;
                    audio.setAttribute('src', `/audio-proxy?url=${encodeURIComponent(absoluteUrl)}`);
                }
            });

            // Preserve essential styles (alignments & bg colors)
            const allElements = document.querySelectorAll('body *');
            allElements.forEach(el => {
                const preserved = extractEssentialStyles(el);
                if (preserved) {
                    el.setAttribute('style', preserved);
                } else {
                    el.removeAttribute('style');
                }
                
                el.removeAttribute('align');
                el.removeAttribute('bgcolor');
            });

            // Strip clutter (CSS files, SVGs, scripts, canvas)
            const clutter = document.querySelectorAll('script, style, iframe, svg, canvas, link[rel="stylesheet"]');
            clutter.forEach(el => el.remove());

            const cleanHtml = `
                <!DOCTYPE html>
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
                </body>
                </html>
            `;

            res.setHeader('Content-Type', 'text/html');
            res.send(cleanHtml);
        }, 1200);

    } catch (err) {
        res.status(500).send(`FeatherNet Proxy Error: ${err.message}`);
    }
});

// ==========================================
// 2. JSON API ENDPOINT (For Native Clients)
// ==========================================
app.get('/api/v1/page', async (req, res) => {
    const targetUrl = req.query.url;

    if (!targetUrl) {
        return res.status(400).json({ error: 'Missing url parameter' });
    }

    try {
        const response = await axios.get(targetUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
        });

        const dom = new JSDOM(response.data, {
            url: targetUrl,
            runScripts: "dangerously",
            resources: "usable"
        });

        setTimeout(() => {
            const document = dom.window.document;

            // Extract links
            const links = [];
            document.querySelectorAll('a[href]').forEach((a, i) => {
                links.push({
                    id: i + 1,
                    text: a.textContent.trim(),
                    href: a.getAttribute('href')
                });
            });

            // Extract text/layout blocks with essential styles preserved
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

            res.json({
                title: document.title || 'FeatherNet Page',
                blocks: blocks,
                links: links
            });
        }, 1200);

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// 3. LOW-BANDWIDTH AUDIO STREAM PROXY
// ==========================================
app.get('/audio-proxy', (req, res) => {
    const audioUrl = req.query.url;

    if (!audioUrl) {
        return res.status(400).send('Error: Missing audio url');
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
