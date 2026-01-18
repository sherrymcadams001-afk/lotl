"""
LotL CLI - Command-line interface for the LotL controller

Usage:
    lotl start              Start the controller
    lotl stop               Stop the controller  
    lotl status             Check controller status
    lotl ask "prompt"       Send a quick prompt
    lotl chrome             Start Chrome with debugging
"""

import argparse
import sys
import json
from pathlib import Path


def cmd_start(args):
    """Start the LotL controller."""
    from .controller import LotLController
    
    try:
        controller = LotLController(
            port=args.port,
            chrome_port=args.chrome_port
        )
        controller.start(wait=True, timeout=15)
        print(f"\n💡 Use 'lotl ask \"your prompt\"' to send prompts")
    except FileNotFoundError as e:
        print(f"❌ {e}")
        sys.exit(1)
    except RuntimeError as e:
        print(f"❌ {e}")
        sys.exit(1)


def cmd_stop(args):
    """Stop the LotL controller."""
    import httpx
    
    try:
        # Try to send shutdown signal
        response = httpx.post(
            f"http://localhost:{args.port}/shutdown",
            timeout=5
        )
        print("🛑 Controller stopped")
    except:
        print("ℹ️  Controller not running or already stopped")


def cmd_status(args):
    """Check controller status."""
    import httpx
    
    # Check Chrome
    chrome_ok = False
    try:
        response = httpx.get(f"http://127.0.0.1:{args.chrome_port}/json", timeout=2)
        pages = response.json()
        aistudio = any(
            "aistudio.google.com" in p.get("url", "")
            for p in pages
        )
        chrome_ok = True
        print(f"🌐 Chrome: ✅ Running on port {args.chrome_port}")
        if aistudio:
            print("   └─ AI Studio tab detected")
        else:
            print("   └─ ⚠️  No AI Studio tab (open https://aistudio.google.com)")
    except:
        print(f"🌐 Chrome: ❌ Not running (use 'lotl chrome' to start)")
    
    # Check controller
    try:
        response = httpx.get(f"http://localhost:{args.port}/health", timeout=2)
        data = response.json()
        print(f"🤖 Controller: ✅ Running on port {args.port}")
        if data.get("connected"):
            print("   └─ Connected to Chrome")
        else:
            print("   └─ ⚠️  Not connected to Chrome")
    except:
        print(f"🤖 Controller: ❌ Not running (use 'lotl start')")


def cmd_ask(args):
    """Send a prompt to the controller."""
    import httpx
    
    prompt = args.prompt
    if not prompt:
        # Read from stdin
        print("Enter prompt (Ctrl+D to send):")
        prompt = sys.stdin.read().strip()
    
    if not prompt:
        print("❌ No prompt provided")
        sys.exit(1)
    
    try:
        response = httpx.post(
            f"http://localhost:{args.port}/aistudio",
            json={"prompt": prompt},
            timeout=args.timeout
        )
        if response.status_code == 404:
            response = httpx.post(
                f"http://localhost:{args.port}/chat",
                json={"prompt": prompt},
                timeout=args.timeout
            )
        data = response.json()
        
        if data.get("success"):
            reply = data.get("reply", "")
            if args.json:
                print(json.dumps({"success": True, "reply": reply}))
            else:
                print(reply)
        else:
            error = data.get("error", "Unknown error")
            if args.json:
                print(json.dumps({"success": False, "error": error}))
            else:
                print(f"❌ {error}")
                sys.exit(1)
                
    except httpx.ConnectError:
        msg = "Cannot connect to controller. Start it with 'lotl start'"
        if args.json:
            print(json.dumps({"success": False, "error": msg}))
        else:
            print(f"❌ {msg}")
        sys.exit(1)
    except httpx.TimeoutException:
        msg = f"Request timed out after {args.timeout}s"
        if args.json:
            print(json.dumps({"success": False, "error": msg}))
        else:
            print(f"❌ {msg}")
        sys.exit(1)


def cmd_chrome(args):
    """Start Chrome with remote debugging."""
    from .controller import start_chrome
    
    try:
        start_chrome(
            port=args.chrome_port,
            user_data_dir=args.profile
        )
        print(f"\n📋 Next steps:")
        print(f"   1. Log in to Google AI Studio")
        print(f"   2. Run 'lotl start' to start the controller")
    except FileNotFoundError as e:
        print(f"❌ {e}")
        sys.exit(1)


def cmd_version(args):
    """Print version."""
    from . import __version__
    print(f"lotl {__version__}")


def main():
    parser = argparse.ArgumentParser(
        prog="lotl",
        description="LotL - Living off the Land LLM interface"
    )
    parser.add_argument(
        "--port", "-p",
        type=int,
        default=3000,
        help="Controller port (default: 3000)"
    )
    parser.add_argument(
        "--chrome-port", "-c",
        type=int,
        default=9222,
        help="Chrome debugging port (default: 9222)"
    )
    
    subparsers = parser.add_subparsers(dest="command", help="Commands")
    
    # start
    p_start = subparsers.add_parser("start", help="Start the controller")
    p_start.set_defaults(func=cmd_start)
    
    # stop
    p_stop = subparsers.add_parser("stop", help="Stop the controller")
    p_stop.set_defaults(func=cmd_stop)
    
    # status
    p_status = subparsers.add_parser("status", help="Check status")
    p_status.set_defaults(func=cmd_status)
    
    # ask
    p_ask = subparsers.add_parser("ask", help="Send a prompt")
    p_ask.add_argument("prompt", nargs="?", help="The prompt to send")
    p_ask.add_argument("--json", "-j", action="store_true", help="Output as JSON")
    p_ask.add_argument("--timeout", "-t", type=int, default=300, help="Timeout in seconds")
    p_ask.set_defaults(func=cmd_ask)
    
    # chrome
    p_chrome = subparsers.add_parser("chrome", help="Start Chrome with debugging")
    p_chrome.add_argument("--profile", help="Chrome profile directory")
    p_chrome.set_defaults(func=cmd_chrome)
    
    # version
    p_version = subparsers.add_parser("version", help="Print version")
    p_version.set_defaults(func=cmd_version)
    
    args = parser.parse_args()
    
    if not args.command:
        parser.print_help()
        sys.exit(1)
    
    args.func(args)


if __name__ == "__main__":
    main()
