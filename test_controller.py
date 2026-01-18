
import requests
import json

url = "http://127.0.0.1:3000/chat"
payload = {
    "prompt": "Hello, are you working? Reply with 'YES I AM WORKING'",
    "target": "gemini",
    "newChat": False
}

try:
    print(f"Sending request to {url}...")
    response = requests.post(url, json=payload, timeout=60)
    print(f"Status Code: {response.status_code}")
    print(f"Response: {response.text}")
except Exception as e:
    print(f"Error: {e}")
