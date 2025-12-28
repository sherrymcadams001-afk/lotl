# 🤖 LotL Controller (Living off the Land)

A hybrid controller that connects to your existing Chrome browser to automate AI chat interfaces like **Gemini AI Studio** and **ChatGPT**.

## Features

- **Stealth Input**: Uses Puppeteer for human-like typing
- **Network-based Timing**: Monitors backend API calls for robust response detection
- **Self-Healing Selectors**: Tries multiple selector strategies to handle UI changes
- **REST API**: Simple HTTP interface for integration

## Installation

Requires Node.js installed.

```bash
cd lotl-agent
npm install puppeteer-core express body-parser
```

## Setup

### 1. Launch Chrome with Remote Debugging

You must launch Chrome with the debugging port enabled.

**Windows (PowerShell):**
```powershell
Start-Process "chrome.exe" -ArgumentList "--remote-debugging-port=9222", "--user-data-dir=C:\temp\chrome-lotl"
```

**Mac:**
```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222 --user-data-dir="/tmp/chrome-lotl"
```

**Linux:**
```bash
google-chrome --remote-debugging-port=9222 --user-data-dir="/tmp/chrome-lotl"
```

### 2. Log In to AI Services

In the new Chrome window, manually log in to:
- `https://aistudio.google.com` (for Gemini)
- `https://chatgpt.com` (for ChatGPT)

Keep these tabs open.

### 3. Run the Controller

```bash
node lotl-controller.js
```

You should see:
```
🚀 LotL Controller running on port 3000
```

## Usage

### Test via Terminal (curl)

**Gemini:**
```bash
curl -X POST http://localhost:3000/chat -H "Content-Type: application/json" -d "{\"target\": \"gemini\", \"prompt\": \"Write a haiku about hackers.\"}"
```

**ChatGPT:**
```bash
curl -X POST http://localhost:3000/chat -H "Content-Type: application/json" -d "{\"target\": \"chatgpt\", \"prompt\": \"Explain JSON in one sentence.\"}"
```

### PowerShell

```powershell
Invoke-RestMethod -Uri "http://localhost:3000/chat" -Method Post -ContentType "application/json" -Body '{"target": "gemini", "prompt": "Hello, Gemini!"}'
```

### Python Integration

```python
import requests

response = requests.post('http://localhost:3000/chat', json={
    'target': 'gemini',
    'prompt': 'Explain quantum computing in simple terms.'
})

print(response.json()['reply'])
```

## API Reference

### POST /chat

Send a prompt to an AI service.

**Request Body:**
```json
{
    "target": "gemini",  // or "chatgpt"
    "prompt": "Your message here"
}
```

**Response:**
```json
{
    "success": true,
    "reply": "The AI's response..."
}
```

**Error Response:**
```json
{
    "success": false,
    "error": "Error message"
}
```

## Supported Adapters

| Target | Service | URL |
|--------|---------|-----|
| `gemini` | Google AI Studio | aistudio.google.com |
| `chatgpt` | ChatGPT | chatgpt.com |

## Troubleshooting

### "Connection failed. Is Chrome running on port 9222?"
- Make sure Chrome is launched with `--remote-debugging-port=9222`
- Check if port 9222 is not blocked by firewall

### "Tab for X not found"
- Open the correct tab in Chrome (aistudio.google.com or chatgpt.com)
- Make sure you're logged in

### "UI Helper: Could not find element"
- The UI may have changed. Check the selectors in `ADAPTERS` config
- Try refreshing the page in Chrome

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
