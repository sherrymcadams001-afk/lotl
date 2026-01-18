# LotL Controller (Local AI Studio + ChatGPT via Chrome)

LotL is a local HTTP controller that attaches to an existing Chrome session (via CDP) and drives:
- **AI Studio (Gemini)**: `POST /aistudio` (text + images)
- **ChatGPT**: `POST /chatgpt` (text-only)

It’s designed for stability: readiness probing, per-provider locking, DOM-first interaction, and image upload support for AI Studio.

## Prereqs

- Node.js 18+
- Google Chrome launched with `--remote-debugging-port=9222`
- Logged-in tabs open:
    - https://aistudio.google.com (required)
    - https://chatgpt.com (optional, only for `/chatgpt`)

## Install

```powershell
cd lotl-agent
npm install
```

## Start

### 1) Launch Chrome with remote debugging

```powershell
Start-Process "chrome.exe" -ArgumentList "--remote-debugging-port=9222", "--user-data-dir=C:\temp\chrome-lotl"
```

### 2) Start the controller

Local-only bind (recommended):

```powershell
npm run start:local
```

LAN bind (only if you need it):

```powershell
npm run start:lan
```

## Verify

```powershell
curl http://127.0.0.1:3000/health
curl http://127.0.0.1:3000/ready
```

`/ready` should return `ok: true` and show an AI Studio URL + `hasInput: true`.

## Use

### AI Studio (text)

```powershell
$body = @{ prompt = "Reply with just OK" } | ConvertTo-Json
Invoke-RestMethod -Uri "http://127.0.0.1:3000/aistudio" -Method Post -ContentType "application/json" -Body $body -TimeoutSec 90
```

### AI Studio (image)

Send base64 *data URLs*:

```powershell
$img = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
$body = @{ prompt = "What color is this image? Reply with just the color."; images = @($img) } | ConvertTo-Json -Depth 3
Invoke-RestMethod -Uri "http://127.0.0.1:3000/aistudio" -Method Post -ContentType "application/json" -Body $body -TimeoutSec 120
```

### ChatGPT (text-only)

```powershell
$body = @{ prompt = "Say hello" } | ConvertTo-Json
Invoke-RestMethod -Uri "http://127.0.0.1:3000/chatgpt" -Method Post -ContentType "application/json" -Body $body -TimeoutSec 90
```

### Legacy endpoint (backward-compatible)

```powershell
$body = @{ target = "gemini"; prompt = "Hello" } | ConvertTo-Json
Invoke-RestMethod -Uri "http://127.0.0.1:3000/chat" -Method Post -ContentType "application/json" -Body $body -TimeoutSec 90
```

## Troubleshooting

- `/ready` is `503` / `ok:false`
    - Ensure Chrome is launched with `--remote-debugging-port=9222` and AI Studio is open + logged in.
- Requests hang or time out
    - Bring the AI Studio tab to the foreground and ensure it’s not showing a security prompt.
- `npm run start:*` says `node` not found
    - Scripts auto-extend `PATH`, but if you’re in a custom environment, use the full path: `C:\Program Files\nodejs\node.exe lotl-controller-v3.js`.

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                    LotL Controller                        │
│  ┌────────────────┐  ┌────────────────┐  ┌────────────┐  │
│  │ Express Server │  │ Puppeteer Core │  │  Adapters  │  │
│  │   (Port 3000)  │──│   (CDP/WSS)    │──│ Gemini/GPT │  │
│  └────────────────┘  └────────────────┘  └────────────┘  │
└──────────────────────────────────────────────────────────┘
                              │
                              ▼
┌──────────────────────────────────────────────────────────┐
│           Chrome Browser (Port 9222)                      │
│  ┌─────────────────┐  ┌─────────────────┐                │
│  │ Gemini Tab      │  │ ChatGPT Tab     │                │
│  └─────────────────┘  └─────────────────┘                │
└──────────────────────────────────────────────────────────┘
```

## License

MIT
