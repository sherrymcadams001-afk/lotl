# LotL - Living off the Land AI Interface

Route AI prompts through a logged-in Google AI Studio session to bypass API quotas and rate limits.

## Installation

```bash
pip install lotl

# With LangChain support
pip install lotl[langchain]
```

## Quick Start

```python
from lotl import LotL

# One-liner
response = LotL.ask("What is the capital of France?")
print(response)

# With images
response = LotL.ask("Describe this image", images=["screenshot.png"])
```

## Prerequisites

1. **Node.js 18+** - Required to run the controller
2. **Google Chrome** - With remote debugging enabled
3. **AI Studio Account** - Logged in at https://aistudio.google.com

## Setup

### 1. Start Chrome with Remote Debugging

```bash
# Windows
chrome --remote-debugging-port=9222 --user-data-dir=C:\temp\chrome-lotl

# macOS
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-lotl

# Linux  
google-chrome --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-lotl
```

Then navigate to https://aistudio.google.com and log in.

### 2. Start the Controller

```bash
# CLI
lotl start

# Or programmatically
from lotl import LotL
LotL.start_controller()
```

## Usage

### Simple API

```python
from lotl import LotL

# Check if controller is running
if LotL.available():
    response = LotL.ask("Hello, AI!")
    print(response)
```

### Client API

```python
from lotl import LotLClient

client = LotLClient()

# Sync
response = client.chat("What is Python?")

# Async
import asyncio
response = asyncio.run(client.achat("What is Python?"))

# With images
response = client.chat(
    "What's in these images?",
    images=["image1.png", "image2.jpg"]
)
```

### LangChain Integration

```python
from lotl import get_lotl_llm
from langchain_core.messages import HumanMessage

llm = get_lotl_llm()

# Simple
response = llm.invoke("What is 2+2?")
print(response.content)

# With structured output
from pydantic import BaseModel

class Answer(BaseModel):
    answer: int
    explanation: str

structured = llm.with_structured_output(Answer)
result = structured.invoke("What is 2+2?")
print(result.answer)  # 4
```

## CLI Commands

```bash
# Start controller
lotl start

# Check status
lotl status

# Send a quick prompt
lotl ask "What is the meaning of life?"

# Start Chrome with debugging
lotl chrome

# Stop controller
lotl stop
```

## API Reference

### LotL Class

| Method | Description |
|--------|-------------|
| `LotL.ask(prompt, images)` | Send prompt, return response |
| `LotL.aask(prompt, images)` | Async version |
| `LotL.available()` | Check if controller is running |
| `LotL.health()` | Get controller health info |
| `LotL.start_controller()` | Start the Node.js controller |
| `LotL.stop_controller()` | Stop the controller |
| `LotL.get_langchain_llm()` | Get LangChain-compatible LLM |

### LotLClient Class

```python
client = LotLClient(
    base_url="http://localhost:3000",
    timeout=300.0
)

client.chat(prompt, images=None, timeout=None)
await client.achat(prompt, images=None, timeout=None)
client.health()
client.is_available()
```

### Controller Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/aistudio` | POST | Send prompt (and optional images) to AI Studio |
| `/chatgpt` | POST | Send prompt to ChatGPT (text-only) |
| `/chat` | POST | Legacy unified endpoint (backward-compatible) |
| `/ready` | GET | Readiness probe (Chrome + AI Studio tab + selectors) |
| `/health` | GET | Health check |

## Architecture

```
┌─────────────┐     HTTP      ┌─────────────────┐   Puppeteer   ┌─────────┐
│ Your Python │ ───────────► │ LotL Controller │ ────────────► │ Chrome  │
│    Code     │ ◄─────────── │   (Node.js)     │ ◄──────────── │AI Studio│
└─────────────┘              └─────────────────┘               └─────────┘
      Port 3000                    Port 9222
```

## Why "Living off the Land"?

In security, "Living off the Land" means using existing tools rather than installing new ones. 
This project uses your existing logged-in AI Studio session rather than API keys - 
no quotas, no rate limits, no API costs.

## License

MIT
