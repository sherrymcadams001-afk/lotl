# LotL Controller v3

> **Living-off-the-Land AI API** — Turn your logged-in browser tabs into a local REST API for Gemini, AI Studio, and ChatGPT.

LotL attaches to an existing Chrome session (via CDP) and exposes HTTP endpoints to send prompts and receive responses. No API keys needed — it uses your logged-in browser sessions.

## Features

- **Multiple AI Platforms**: Gemini Web, AI Studio (with images), ChatGPT
- **Request Serialization**: One prompt at a time per platform — no race conditions
- **Bot-Safe**: Uses clipboard paste (never types) to avoid detection
- **Large Prompts**: Clipboard-based input handles prompts of any size
- **Remote Access**: Bind to `0.0.0.0` for access from other machines
- **API Documentation**: Built-in `/docs` endpoint for client integration

---

## Quick Start

### Prerequisites

- **Node.js 18+** (for native fetch)
- **Google Chrome** launched with remote debugging
- **Logged-in tabs** open to the AI platforms you want to use

### 1. Install Dependencies

```powershell
cd lotl-agent
npm install
```

### 2. Launch Chrome with Remote Debugging

> **Important**: Use a persistent `--user-data-dir` so your login stays saved. One Google login covers both AI Studio AND Gemini.

```powershell
# Windows (persistent profile in AppData)
& "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="$env:LOCALAPPDATA\LotL\chrome-lotl"

# macOS
open -na "Google Chrome" --args --remote-debugging-port=9222 --user-data-dir="$HOME/.lotl/chrome-profile"

# Linux
google-chrome --remote-debugging-port=9222 --user-data-dir="$HOME/.lotl/chrome-profile"
```

### 3. Login Once (First Time Only)

In the launched Chrome:
1. Go to **https://aistudio.google.com** and sign in with your Google account
2. That's it! Your Google login now works for both `/aistudio` AND `/gemini` endpoints
3. (Optional) For ChatGPT: go to https://chatgpt.com and login separately

> **Tip**: Keep these tabs open. The controller finds them automatically.

### 4. Start the Controller

```powershell
cd lotl-agent
node lotl-controller-v3.js
```

You'll see:
```
════════════════════════════════════════════════════════════
🤖 LOTL CONTROLLER v3 - SOLIDIFIED
════════════════════════════════════════════════════════════
🌐 Listening on http://0.0.0.0:3000
⚙️  Mode: api

🔒 SERIALIZATION: One prompt at a time per platform (queued)
📋 CLIPBOARD: Prompts pasted, never typed (bot-safe, large prompts OK)

🌍 REMOTE ACCESS ENABLED (bound to 0.0.0.0)
════════════════════════════════════════════════════════════
```

---

## API Reference

### Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/gemini` | POST | Send prompt to Gemini Web |
| `/aistudio` | POST | Send prompt to AI Studio (supports images) |
| `/chatgpt` | POST | Send prompt to ChatGPT |
| `/chat` | POST | Legacy unified endpoint (use `target` param) |
| `/health` | GET | Basic health check |
| `/ready` | GET | Deep readiness probe |
| `/docs` | GET | Full API documentation (JSON) |

### Request Format

```json
{
  "prompt": "Your prompt text here",
  "sessionId": "optional-session-id",
  "images": ["data:image/png;base64,..."]  // AI Studio only
}
```

### Response Format

```json
{
  "success": true,
  "reply": "The model's response text",
  "platform": "gemini",
  "requestId": "req_1737817234567_abc123",
  "timestamp": "2026-01-25T15:30:00.000Z"
}
```

---

## Usage Examples

### Local Usage (PowerShell)

```powershell
# Simple prompt to Gemini
$body = @{ prompt = "Explain quantum computing in one sentence" } | ConvertTo-Json
Invoke-RestMethod -Uri "http://127.0.0.1:3000/gemini" -Method Post -ContentType "application/json" -Body $body

# AI Studio with image
$img = [Convert]::ToBase64String([IO.File]::ReadAllBytes("photo.png"))
$body = @{ prompt = "Describe this image"; images = @("data:image/png;base64,$img") } | ConvertTo-Json -Depth 3
Invoke-RestMethod -Uri "http://127.0.0.1:3000/aistudio" -Method Post -ContentType "application/json" -Body $body -TimeoutSec 120

# ChatGPT
$body = @{ prompt = "Write a haiku about coding" } | ConvertTo-Json
Invoke-RestMethod -Uri "http://127.0.0.1:3000/chatgpt" -Method Post -ContentType "application/json" -Body $body
```

### Local Usage (curl)

```bash
# Gemini
curl -X POST http://127.0.0.1:3000/gemini \
  -H "Content-Type: application/json" \
  -d '{"prompt":"Hello, how are you?"}'

# AI Studio
curl -X POST http://127.0.0.1:3000/aistudio \
  -H "Content-Type: application/json" \
  -d '{"prompt":"Explain machine learning"}'

# ChatGPT
curl -X POST http://127.0.0.1:3000/chatgpt \
  -H "Content-Type: application/json" \
  -d '{"prompt":"Tell me a joke"}'
```

### Local Usage (Python)

```python
import requests

# Send prompt to Gemini
response = requests.post(
    "http://127.0.0.1:3000/gemini",
    json={"prompt": "What is the capital of France?"},
    timeout=120
)
data = response.json()
print(data["reply"])
```

### Local Usage (Node.js)

```javascript
const response = await fetch("http://127.0.0.1:3000/gemini", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ prompt: "Hello!" })
});
const data = await response.json();
console.log(data.reply);
```

---

## Remote Access

The controller binds to `0.0.0.0` by default, allowing remote agents to connect.

### Enable Firewall (Windows)

```powershell
# Run as Administrator
netsh advfirewall firewall add rule name="LotL Controller" dir=in action=allow protocol=TCP localport=3000
```

### Remote Agent Usage

From any machine on the network:

```bash
curl -X POST http://192.168.1.100:3000/gemini \
  -H "Content-Type: application/json" \
  -d '{"prompt":"Hello from remote agent"}'
```

### Restrict to Local Only

```powershell
$env:HOST = "127.0.0.1"
node lotl-controller-v3.js
```

---

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | HTTP server port |
| `HOST` | `0.0.0.0` | Bind address (`127.0.0.1` for local-only) |
| `CHROME_PORT` | `9222` | Chrome DevTools Protocol port |
| `LOTL_MODE` | `api` | Operation mode (see below) |
| `ACTION_DELAY_MS` | `0` | Base delay between actions (ms) |
| `ACTION_DELAY_JITTER_MS` | `0` | Random jitter added to delay |
| `LOCK_TIMEOUT_MS_TEXT` | `420000` | Timeout for text requests (7 min) |
| `LOCK_TIMEOUT_MS_IMAGES` | `900000` | Timeout for image requests (15 min) |

### Operation Modes

| Mode | Description |
|------|-------------|
| `api` | **(Default)** Reuses one tab per platform. Starts fresh chat each request via `Ctrl+Shift+O`. Best for stateless API usage. |
| `normal` | Reuses one tab, does NOT start new chat. Continues the conversation. |
| `single` | Opens fresh tab for each request, closes after. Slowest but cleanest isolation. |
| `multi` | Session-aware. Different `sessionId` values get separate tabs (up to `MULTI_MAX_SESSIONS`). |

### Example: Custom Configuration

```powershell
$env:PORT = "3001"
$env:CHROME_PORT = "9230"
$env:LOTL_MODE = "single"
$env:ACTION_DELAY_MS = "200"
node lotl-controller-v3.js
```

---

## Multiple Instances

Run separate Chrome profiles + controllers for complete isolation (e.g., different Google accounts):

### Instance A (Port 3000, Chrome 9222)

```powershell
# Terminal 1: Chrome (login to Google account A once, stays logged in)
& chrome.exe --remote-debugging-port=9222 --user-data-dir="$env:LOCALAPPDATA\LotL\chrome-9222"

# Terminal 2: Controller
$env:PORT = "3000"; $env:CHROME_PORT = "9222"
node lotl-controller-v3.js
```

### Instance B (Port 3001, Chrome 9223)

```powershell
# Terminal 3: Chrome (login to Google account B once, stays logged in)
& chrome.exe --remote-debugging-port=9223 --user-data-dir="$env:LOCALAPPDATA\LotL\chrome-9223"

# Terminal 4: Controller
$env:PORT = "3001"; $env:CHROME_PORT = "9223"
node lotl-controller-v3.js
```

> **Note**: Each Chrome profile stores its own Google login. Login once per profile, and it persists across restarts.

---

## Health Checks

### Basic Health

```powershell
Invoke-RestMethod http://127.0.0.1:3000/health
```

### Deep Readiness

```powershell
Invoke-RestMethod http://127.0.0.1:3000/ready
```

Returns `ok: true` when browser is connected and AI tabs are accessible.

### Stability Test

```powershell
./scripts/stability_check.ps1 -ControllerUrl http://127.0.0.1:3000 -Count 5 -Target gemini
```

---

## Troubleshooting

### "Cannot connect to Chrome"

- Ensure Chrome is running with `--remote-debugging-port=9222`
- Verify: `curl http://127.0.0.1:9222/json/version`

### "Failed to set input" / "Clipboard paste failed"

- RDP users: Enable clipboard sharing in your RDP client
- Check the AI tab is visible and not showing a modal/popup

### "/ready returns ok: false"

- Open Chrome and check the AI Studio tab
- Look for login prompts, captchas, or "unusual traffic" warnings
- Fix the tab state, then retry

### Requests hang or timeout

- Bring the AI tab to foreground
- Check for security prompts or rate limiting
- Increase `LOCK_TIMEOUT_MS_TEXT` if needed

### "Port already in use"

```powershell
# Find and kill the process
Get-NetTCPConnection -LocalPort 3000 | Select-Object OwningProcess | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
```

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      LotL Controller v3                         │
│  ┌──────────────┐  ┌────────────────┐  ┌────────────────────┐  │
│  │ Express API  │  │ Puppeteer-Core │  │     Adapters       │  │
│  │  /gemini     │──│  (CDP/WSS)     │──│ • Gemini (paste)   │  │
│  │  /aistudio   │  │                │  │ • AI Studio (DOM)  │  │
│  │  /chatgpt    │  │                │  │ • ChatGPT (DOM)    │  │
│  └──────────────┘  └────────────────┘  └────────────────────┘  │
│                              │                                  │
│  🔒 Request Serialization    │  📋 Clipboard-based input       │
│  (one prompt per platform)   │  (bot-safe, large prompts OK)   │
└─────────────────────────────────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────┐
│              Chrome Browser (--remote-debugging-port)           │
│  ┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐   │
│  │  gemini.google  │ │  aistudio.google│ │   chatgpt.com   │   │
│  │    .com         │ │     .com        │ │                 │   │
│  │  (logged in)    │ │  (logged in)    │ │  (logged in)    │   │
│  └─────────────────┘ └─────────────────┘ └─────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

---

## Key Behaviors

### Request Serialization
Requests are queued per platform. If you send 3 prompts to `/gemini` simultaneously, they execute one at a time (FIFO). Each gets a fresh chat and its own response.

### New Chat Per Request (API Mode)
In the default `api` mode, each request:
1. Presses `Ctrl+Shift+O` to start a new chat
2. Pastes the prompt via clipboard
3. Clicks send
4. Waits for response
5. Returns the response

This ensures stateless, API-like behavior.

### Clipboard Paste (Never Types)
Prompts are pasted via the system clipboard, not typed character-by-character. This:
- Avoids bot detection from rapid typing
- Handles large prompts (10KB+) efficiently
- Works reliably across platforms

---

## License

MIT
