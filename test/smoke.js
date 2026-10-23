// Smoke test: boots the server, checks key routes, then shuts it down.
// No external network needed, so CI stays fast and reliable.
const { spawn } = require('child_process');
const http = require('http');

const PORT = 3999;
const server = spawn(process.execPath, ['server.js'], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe']
});

let output = '';
server.stdout.on('data', d => (output += d));
server.stderr.on('data', d => (output += d));

function get(path) {
    return new Promise((resolve, reject) => {
        http.get({ host: '127.0.0.1', port: PORT, path }, res => {
            res.resume();
            res.on('end', () => resolve(res.statusCode));
        }).on('error', reject);
    });
}

async function waitForServer() {
    for (let i = 0; i < 30; i++) {
        try { await get('/'); return; } catch { await new Promise(r => setTimeout(r, 200)); }
    }
    throw new Error('Server did not start:\n' + output);
}

function expect(name, actual, expected) {
    if (actual !== expected) throw new Error(`${name}: expected ${expected}, got ${actual}`);
    console.log(`ok - ${name}`);
}

(async () => {
    try {
        await waitForServer();
        expect('GET / serves the client', await get('/'), 200);
        expect('missing url param returns 400 (API)', await get('/api/v1/page'), 400);
        expect('SSRF: loopback target blocked', await get('/search?url=http://127.0.0.1:' + PORT + '/'), 400);
        expect('SSRF: cloud metadata blocked', await get('/search?url=http://169.254.169.254/'), 400);
        expect('SSRF: audio proxy blocks loopback', await get('/audio-proxy?url=http://127.0.0.1/'), 400);
        console.log('All smoke tests passed');
        process.exitCode = 0;
    } catch (err) {
        console.error('FAILED:', err.message);
        process.exitCode = 1;
    } finally {
        server.kill();
    }
})();
