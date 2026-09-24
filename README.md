# FeatherNet

**FeatherNet** is a 100% Vibe coded ultra-lightweight, low-bandwidth web runtime and proxy engine designed for low-spec hardware, feature phones (S30+, KaiOS, Mocor RTOS), and resource-constrained devices.

By offloading heavy DOM parsing, layout rendering, JavaScript execution, and media compression to a Node.js backend, FeatherNet delivers fast, responsive web content over 2G/3G/4G networks with near-zero RAM footprint on the client device.

---

## Key Features

* **Server-Side JS Execution:** Runs dynamic page scripts sandboxed via `jsdom` on the server before stripping heavy bloat, delivering clean HTML/JSON to the client.
* **Low-Bandwidth Audio Transcoding:** Rewrites HTML5 `<audio>` streams on the fly and proxies them through `ffmpeg` into ultra-low-bitrate 32kbps mono AAC streams.
* **Style & Layout Preservation:** Preserves essential text alignments (`text-align`) and background colors (`background-color`) from inline CSS and legacy HTML attributes while stripping heavy stylesheets.
* **Dual Output Interfaces:**
* **HTML Renderer (`/render` & `/search`):** Outputs clean, compressed HTML styled for low-resolution displays.
* **JSON API (`/api/v1/page`):** Delivers structured JSON arrays (`blocks` and `links`) for microcontrollers or native apps.


* **Hardware D-Pad Native:** Integrated keypad navigation for 3x4 numeric keypads, D-Pads, and soft keys (`F1` / `*` for search, `F2` / `#` for back).

---

## Project Structure

```text
.
├── server.js          # Express backend, JSDOM parser & FFmpeg proxy
├── package.json       # Project dependencies
└── public/
    └── index.html     # D-Pad optimized web client

```

---

## Getting Started

### Prerequisites

* **Node.js** (v18 or higher recommended)
* **npm**

### Installation

1. **Clone the repository:**
```bash
git clone https://github.com/your-username/feathernet.git
cd feathernet

```


2. **Install dependencies:**
```bash
npm install

```


3. **Start the server:**
```bash
node server.js

```


4. **Access the application:**
* Web Client: Open `http://localhost:3000` in your browser.
* HTML Engine: Navigate to `http://localhost:3000/render?url=[https://wikipedia.org](https://wikipedia.org)`.



---

## API & Route Reference

### 1. Web Client / Search Route

* **URL:** `/search`
* **Method:** `GET`
* **Query Params:** `q` or `url` (e.g., `/search?q=fedora+linux` or `/search?q=wikipedia.org`)
* **Description:** Automatically detects whether the input is a URL or search query. Plain search queries are routed via DuckDuckGo HTML Lite and compressed through FeatherNet.

### 2. JSON API Endpoint

* **URL:** `/api/v1/page`
* **Method:** `GET`
* **Query Params:** `url` (e.g., `/api/v1/page?url=[https://wikipedia.org](https://wikipedia.org)`)
* **Description:** Returns structured JSON containing page titles, text blocks with essential styling, and an indexed list of hyperlinks.

**Example Request:**

```bash
curl -s "http://localhost:3000/api/v1/page?url=https://wikipedia.org"

```

**Example Response:**

```json
{
  "title": "Wikipedia, the free encyclopedia",
  "blocks": [
    {
      "tag": "p",
      "text": "Wikipedia is a free online encyclopedia...",
      "style": "text-align:left"
    }
  ],
  "links": [
    {
      "id": 1,
      "text": "Main page",
      "href": "https://en.wikipedia.org/wiki/Main_Page"
    }
  ]
}

```

### 3. Audio Transcoding Proxy

* **URL:** `/audio-proxy`
* **Method:** `GET`
* **Query Params:** `url` (Direct link to audio stream/file)
* **Description:** Live-transcodes external audio sources into a 32kbps mono AAC stream suitable for low-spec hardware media players.

---

## License

This project is licensed under the MIT License - see the [LICENSE](https://www.google.com/search?q=LICENSE) file for details.
