# LotL Controller API Documentation

> **Living-off-the-Land AI Controller** - Routes AI prompts through a logged-in Google AI Studio session to bypass API quotas and rate limits.

## Quick Start

```bash
# 1. Start Chrome with debugging
Start-Process "chrome.exe" -ArgumentList "--remote-debugging-port=9222", "--user-data-dir=C:\temp\chrome-lotl"

# 2. Open AI Studio in Chrome, log in, start a chat

# 3. Start the controller
cd lotl-agent
npm install
npm run start:local

# 4. Send requests to http://localhost:3000/aistudio (or legacy /chat)
```

---

## API Endpoints

### GET `/ready`

Readiness probe. Returns `200` when the controller can reach Chrome debug port and detect the AI Studio tab + input selector.

```bash
curl http://localhost:3000/ready
```

---

### POST `/aistudio`

Send a prompt (with optional images) to AI Studio.

> Legacy: `POST /chat` is still supported and maps `target=gemini` → AI Studio.

#### Request

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `prompt` | string | ✅ | The text prompt to send |
| `images` | string[] | ❌ | Array of base64 data URLs |

#### Example Request (Text Only)

```json
{
  "prompt": "What is the capital of France? Reply with just the city name."
}
```

#### Example Request (With Image)

```json
{
  "prompt": "Describe what you see in this screenshot",
  "images": [
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
  ]
}
```

#### Response

```json
{
  "success": true,
  "reply": "Paris"
}
```

#### Error Response

```json
{
  "success": false,
  "error": "Timeout waiting for model response"
}
```

---

### GET `/health`

Health check endpoint.

#### Response

```json
{
  "status": "ok",
  "message": "LotL Controller is running"
}
```

---

## Integration Examples

### Python

```python
import requests
import base64

LOTL_ENDPOINT = "http://localhost:3000/aistudio"

# Simple text prompt
def ask_lotl(prompt: str, images: list = None) -> str:
    payload = {"prompt": prompt}
    if images:
        payload["images"] = images
    
    response = requests.post(LOTL_ENDPOINT, json=payload, timeout=180)
    data = response.json()
    
    if data.get("success"):
        return data["reply"]
    else:
        raise Exception(data.get("error", "Unknown error"))

# With screenshot
def ask_with_image(prompt: str, image_path: str) -> str:
    with open(image_path, "rb") as f:
        img_b64 = "data:image/png;base64," + base64.b64encode(f.read()).decode()
    return ask_lotl(prompt, images=[img_b64])

# Usage
result = ask_lotl("What is 2 + 2?")
print(result)  # "4"

# Readiness check
ready = requests.get('http://localhost:3000/ready', timeout=5).json()
print('ready:', ready.get('ok'))
```

### JavaScript/Node.js

```javascript
async function askLotL(prompt, images = []) {
  const response = await fetch('http://localhost:3000/aistudio', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, images })
  });
  
  const data = await response.json();
  if (data.success) {
    return data.reply;
  } else {
    throw new Error(data.error);
  }
}

// Usage
const answer = await askLotL("Explain quantum computing in one sentence");
console.log(answer);
```

### cURL

```bash
# Simple prompt
curl -X POST http://localhost:3000/aistudio \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Hello, what is your name?"}' \
  --max-time 120

# Health check
curl http://localhost:3000/health
```

### PowerShell

```powershell
$body = @{
    prompt = "What is the meaning of life?"
} | ConvertTo-Json

$response = Invoke-RestMethod -Uri "http://localhost:3000/aistudio" `
    -Method POST `
    -ContentType "application/json" `
    -Body $body `
    -TimeoutSec 120

Write-Host $response.reply
```

---

## LangChain Integration

A LangChain-compatible wrapper is available at `Browser-use/lotl_llm.py`:

```python
import sys
sys.path.insert(0, r'c:\Users\Administrator\Desktop\Agents\Browser-use')

from lotl_llm import get_lotl_llm

# Get LangChain-compatible LLM
llm = get_lotl_llm()

# Use like any LangChain LLM
result = llm.invoke("Explain Python decorators")
print(result.content)

# With messages
from langchain_core.messages import HumanMessage, SystemMessage

messages = [
    SystemMessage(content="You are a helpful coding assistant"),
    HumanMessage(content="Write a hello world in Rust")
]
result = llm.invoke(messages)
print(result.content)
```

---

## Browser-Use Agent Integration

Full browser automation agent with vision capabilities:

```python
import asyncio
import sys
sys.path.insert(0, r'c:\Users\Administrator\Desktop\Agents\Browser-use')

from browser_use import Agent
from lotl_llm import get_lotl_llm
from stealth_browser import StealthBrowser

async def main():
    llm = get_lotl_llm()
    
    stealth = StealthBrowser(headless=False)
    await stealth.start()
    
    agent = Agent(
        task="Go to news.ycombinator.com and summarize the top 3 stories",
        llm=llm,
        browser=stealth.browser,
        use_vision=True,  # Screenshots sent to AI Studio
        llm_timeout=180,
        step_timeout=300,
    )
    
    result = await agent.run()
    print(result)
    
    await stealth.stop()

asyncio.run(main())
```

---

## Image Handling

### Supported Formats
- PNG (recommended for screenshots)
- JPEG
- GIF
- WebP

### Format Requirements
Images must be base64 data URLs:
```
data:image/png;base64,<BASE64_DATA>
```

### Upload Method
Images are uploaded via **Google Drive integration** in AI Studio. The controller:
1. Clicks the "Insert" button in AI Studio
2. Selects "Upload from computer" or uses drag-and-drop
3. Uploads the image file
4. Waits for upload confirmation

### Size Recommendations
- Max recommended: 1920x1080 pixels
- Larger images work but increase upload time
- Consider compressing screenshots before sending

---

## Configuration

### Prerequisites

| Component | Requirement |
|-----------|-------------|
| Node.js | v18+ with puppeteer-core |
| Chrome | Running with `--remote-debugging-port=9222` |
| AI Studio | Logged in at https://aistudio.google.com |
| Controller | Running on port 3000 |

### Chrome Launch Command

**Windows:**
```powershell
Start-Process "chrome.exe" -ArgumentList "--remote-debugging-port=9222", "--user-data-dir=C:\temp\chrome-lotl"
```

**macOS:**
```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-lotl
```

**Linux:**
```bash
google-chrome --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-lotl
```

---

## Error Handling

| Error | Cause | Solution |
|-------|-------|----------|
| `Cannot connect to LotL Controller` | Controller not running | Start: `npm run start:local` |
| `AI Studio tab not found` | Chrome not open or AI Studio not loaded | Open https://aistudio.google.com in debugging Chrome |
| `Timeout waiting for response` | AI Studio slow or stuck | Check AI Studio tab, may need new chat session |
| `Empty response` | Parsing failed | Check AI Studio for errors, restart chat |
| `Connection refused` | Chrome debugging not enabled | Restart Chrome with `--remote-debugging-port=9222` |

---

## Rate Limits & Best Practices

### No API Rate Limits
This system uses a logged-in session, so there are **no API quotas**. However:

1. **Add delays between rapid requests** (1 second recommended)
2. **Respect fair use** - don't abuse the system
3. **Monitor AI Studio tab** for any warnings or blocks

### Timeouts
- Default: 180 seconds for response
- Image uploads: Add 2-5 seconds per image
- Complex prompts: May need up to 300 seconds

### Reliability Tips
1. Keep AI Studio tab focused (not minimized)
2. Use a fresh chat session for long runs
3. Monitor for Google account security prompts
4. Restart controller if responses become unreliable

---

## File Structure

```
lotl-agent/
├── lotl-controller-v3.js    # Main controller server
├── api-schema.json          # OpenAPI-style schema
├── API.md                   # This documentation
├── debug-upload-selectors.js # Tool to discover UI selectors
├── test-working.js          # Test script
└── package.json             # Dependencies

Browser-use/
├── lotl_llm.py              # LangChain wrapper
├── stealth_browser.py       # Stealth browser with evasion
└── run_lotl_agent.py        # Example agent script
```

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 3.0.0 | 2025-01 | Separate endpoints (`/aistudio`, `/chatgpt`), readiness probe (`/ready`), hardened DOM-first controller |
| 2.0.0 | 2024-12 | Image upload via Google Drive, FileChooser API |
| 1.0.0 | 2024-12 | Initial release, text-only |
