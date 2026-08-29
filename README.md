# SeriesX Compressor Server

Tiny, dependency-free Node.js server that fetches a web page and strips it
down to `{ status, title, text }` JSON — small enough for a feature-phone
client to render without an HTML/CSS engine.

## Run

```bash
node server.js
```

Runs on port `8080` by default, bound to `0.0.0.0` (all network interfaces,
not just localhost) so a real phone on the same Wi-Fi/LAN can reach it.

Change the port:

```bash
PORT=9000 node server.js
```

## Test from your machine

```bash
curl "http://localhost:8080/fetch?url=example.com"
```

## Test from a phone (same Wi-Fi network)

1. Find your machine's LAN IP:
   - Linux: `hostname -I` or `ip addr show`
   - macOS: `ipconfig getifaddr en0`
   - Windows: `ipconfig` (look for IPv4 Address)
2. On the phone, hit: `http://<your-lan-ip>:8080/fetch?url=example.com`
3. If it doesn't connect, your machine's firewall is probably blocking
   incoming connections on port 8080 — allow it, or temporarily disable
   the firewall to confirm that's the cause.

## API

`GET /fetch?url=<target>`

Response:
```json
{ "status": "ok", "title": "Example Domain", "text": "..." }
```

On failure:
```json
{ "status": "error", "message": "..." }
```

`GET /health` → `{ "status": "ok" }` — for a quick reachability check.

## Notes

- No dependencies — uses Node's built-in `fetch` (Node 18+) and regex-based
  HTML stripping instead of a full parser like Cheerio, keeping this process
  small and fast to start.
- Blocks requests to `localhost`/`127.0.0.1`/`0.0.0.0`/`::1` as a basic
  SSRF guard, since this server is reachable from your whole LAN.
- Responses are capped at ~4000 characters of text to stay light for the
  phone client; long pages get truncated with a `[...truncated]` marker.
