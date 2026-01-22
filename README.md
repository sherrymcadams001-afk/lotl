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

## Modes

The controller supports three modes for clear separation of behaviors:

- **normal** (default): Reuses one existing tab per platform and serializes requests per platform (safest default).
- **single**: Treats every request as a fresh UI session by creating a new tab, navigating to the platform, executing the request, then closing the tab.
- **multi**: Supports multiple simultaneous agent sessions inside one controller by using `sessionId` (each unique `sessionId` gets its own dedicated tab and its own lock).

Set the mode via `--mode` or env `LOTL_MODE`.

Optional pacing (slower, less bursty interactions):
- `ACTION_DELAY_MS` (base delay between key UI actions)
- `ACTION_DELAY_JITTER_MS` (adds random 0..N ms to the base delay)

Examples:

```powershell
npm run start:local -- --mode single
npm run start:local -- --mode multi
```

Quick API examples (`curl.exe`):

```powershell
# Normal mode request (default)
curl.exe -s -X POST "http://127.0.0.1:3000/aistudio" -H "Content-Type: application/json" -d "{\"prompt\":\"Reply with just OK\"}"

# Multi mode (start controller with --mode multi). Each sessionId gets its own dedicated tab.
curl.exe -s -X POST "http://127.0.0.1:3000/aistudio" -H "Content-Type: application/json" -d "{\"prompt\":\"Reply with just: A\",\"sessionId\":\"agent-1\"}"
curl.exe -s -X POST "http://127.0.0.1:3000/aistudio" -H "Content-Type: application/json" -d "{\"prompt\":\"Reply with just: B\",\"sessionId\":\"agent-2\"}"
```

In **multi** mode, run the two `agent-1` / `agent-2` calls from two terminals (or background jobs) to validate simultaneous agent sessions.

Note: for large-scale multi-agent isolation across profiles, Option 1 (multiple Chrome + multiple controllers) is still the most robust.

### Recommended: start an isolated instance (one command)

This starts **both** Chrome (with CDP) and the controller, writes logs to files, and waits for `/ready`.

Important: login is stored in Chrome’s `--user-data-dir`.
- On the first run for a given `ChromePort`/`USER_DATA_DIR`, you may need to open the launched Chrome window and sign in to AI Studio.
- After that, reuse the same `USER_DATA_DIR` and the controller will stay logged in (including **single** mode, since it reuses the same Chrome profile and only opens/closes tabs).

Windows:

```powershell
./scripts/start-instance.ps1 -ControllerPort 3000 -ChromePort 9222 -Mode normal
```

To force a specific persistent profile directory:

```powershell
./scripts/start-instance.ps1 -ControllerPort 3000 -ChromePort 9222 -Mode single -UserDataDir "$env:LOCALAPPDATA\LotL\chrome-lotl-9222"
```

Or via npm:

```powershell
npm run start-instance:win -- -ControllerPort 3000 -ChromePort 9222 -Mode normal
```

If Chrome or Node aren’t on PATH, pass explicit paths:

```powershell
./scripts/start-instance.ps1 -ControllerPort 3000 -ChromePort 9222 -Mode normal -NodePath "C:\Program Files\nodejs\node.exe" -ChromePath "C:\Program Files\Google\Chrome\Application\chrome.exe"
```

macOS / Linux:

```bash
chmod +x scripts/start-instance.sh
./scripts/start-instance.sh 3000 9222
```

To force a specific persistent profile directory:

```bash
USER_DATA_DIR="$HOME/.lotl/chrome-lotl-9222" MODE=single ./scripts/start-instance.sh 3000 9222
```

Or via npm (requires `bash`):

```bash
npm run start-instance -- 3000 9222
```

Environment overrides:
- `USER_DATA_DIR` (Chrome profile dir)
- `WAIT_READY_SEC` (default `180`)
- `CHROME_PATH` (Linux, or direct binary override)
- `MODE` (controller mode: `normal|single|multi`)

---

### 1) Launch Chrome with remote debugging

```powershell
npm run launch-chrome
```

If Windows can’t find `node`, use:

```powershell
npm run launch-chrome:win
```

macOS (alternative to `npm run launch-chrome`):

```bash
open -na "Google Chrome" --args --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-lotl-9222
```

### 2) Start the controller

Local-only bind (recommended):

```powershell
npm run start:local
```

If Windows can’t find `node` (common in locked-down shells), use:

```powershell
npm run start:local:win
```

LAN bind (only if you need it):

```powershell
npm run start:lan
```

Windows fallback:

```powershell
npm run start:lan:win
```

## Multiple agent systems (Option 1: multiple Chrome + multiple controllers)

Run one Chrome profile + controller per agent system. Each system must have a unique Chrome debug port and controller HTTP port.

Example: two AI Studio agent systems on the same machine:

Recommended (Windows):

```powershell
./scripts/start-instance.ps1 -ControllerPort 3000 -ChromePort 9222 -UserDataDir C:\temp\chrome-lotl-9222
./scripts/start-instance.ps1 -ControllerPort 3001 -ChromePort 9223 -UserDataDir C:\temp\chrome-lotl-9223
```

```powershell
# Agent system A
npm run launch-chrome:win -- --chrome-port 9222 --user-data-dir C:\temp\chrome-lotl-9222
npm run start:local:win -- --port 3000 --chrome-port 9222

# Agent system B
npm run launch-chrome:win -- --chrome-port 9223 --user-data-dir C:\temp\chrome-lotl-9223
npm run start:local:win -- --port 3001 --chrome-port 9223
```

macOS equivalent:

Recommended (macOS/Linux):

```bash
USER_DATA_DIR=/tmp/chrome-lotl-9222 ./scripts/start-instance.sh 3000 9222
USER_DATA_DIR=/tmp/chrome-lotl-9223 ./scripts/start-instance.sh 3001 9223
```

```bash
# Agent system A
node scripts/launch-chrome.js --chrome-port 9222 --user-data-dir /tmp/chrome-lotl-9222
npm run start:local -- --port 3000 --chrome-port 9222

# Agent system B
node scripts/launch-chrome.js --chrome-port 9223 --user-data-dir /tmp/chrome-lotl-9223
npm run start:local -- --port 3001 --chrome-port 9223
```

## Verify

```powershell
curl http://127.0.0.1:3000/health
curl http://127.0.0.1:3000/ready
```

`/ready` should return `ok: true` and show an AI Studio URL + `hasInput: true`.

If `/ready` returns `ok:false` with `blockers`, the AI Studio tab is likely in a blocked UI state (login, verification, captcha/unusual traffic). Fix the AI Studio tab until `/ready` is healthy.

## Stability check (production)

Run a small sequential probe (fails fast if `/ready` is unhealthy):

```powershell
./scripts/stability_check.ps1 -ControllerUrl http://127.0.0.1:3000 -Count 8 -TimeoutSec 180 -Target aistudio
```

## Production notes

- Prefer starting the controller detached (so it survives shell disconnect) and writing logs to files (for example `controller_3000.out.log` / `controller_3000.err.log`).
- Use `/health` for liveness and `/ready` for real usability checks.
- For multiple agent systems, use Option 1 (multiple Chrome debug ports + multiple controller ports) to isolate sessions.

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
