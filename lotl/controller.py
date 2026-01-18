"""
LotL Controller - Manages the Node.js controller server
"""

import subprocess
import shutil
import time
import sys
import os
from pathlib import Path
from typing import Optional
import httpx


class LotLController:
    """
    Manages the LotL Node.js controller server.
    
    The controller connects to a Chrome browser with remote debugging
    and routes prompts through Google AI Studio.
    
    Examples:
        # Start controller
        controller = LotLController()
        controller.start()
        
        # Check status
        print(controller.is_running())
        
        # Stop controller
        controller.stop()
    """
    
    def __init__(
        self,
        port: int = 3000,
        chrome_port: int = 9222,
        controller_path: Optional[Path] = None
    ):
        """
        Initialize the controller manager.
        
        Args:
            port: Port for the controller server (default: 3000)
            chrome_port: Chrome debugging port (default: 9222)
            controller_path: Path to lotl-controller-v3.js (auto-detected)
        """
        self.port = port
        self.chrome_port = chrome_port
        self.process: Optional[subprocess.Popen] = None
        
        # Find controller script
        if controller_path:
            self.controller_path = Path(controller_path)
            if not self.controller_path.exists():
                raise FileNotFoundError(f"Controller script not found: {self.controller_path}")
        else:
            self.controller_path = self._find_controller()
    
    def _find_controller(self) -> Path:
        """Find the controller script."""
        # Check common locations
        search_paths = [
            Path(__file__).parent / "controller" / "lotl-controller-v3.js",
            Path(__file__).parent.parent / "lotl-controller-v3.js",
            Path.cwd() / "lotl-controller-v3.js",
            Path.cwd() / "lotl-agent" / "lotl-controller-v3.js",
        ]
        
        for path in search_paths:
            if path.exists():
                return path
        
        raise FileNotFoundError(
            "Cannot find lotl-controller-v3.js. "
            "Please specify controller_path or ensure the file exists."
        )
    
    def _find_node(self) -> str:
        """Find Node.js executable."""
        # Try common locations
        node_paths = [
            "node",
            "C:\\Program Files\\nodejs\\node.exe",
            "C:\\Program Files (x86)\\nodejs\\node.exe",
            "/usr/bin/node",
            "/usr/local/bin/node",
        ]
        
        for node in node_paths:
            if shutil.which(node):
                return node
        
        raise FileNotFoundError(
            "Node.js not found. Please install Node.js v18+ "
            "from https://nodejs.org"
        )
    
    def is_running(self) -> bool:
        """Check if the controller is running."""
        try:
            response = httpx.get(
                f"http://localhost:{self.port}/health",
                timeout=2.0
            )
            return response.json().get("status") == "ok"
        except:
            return False
    
    def is_chrome_ready(self) -> bool:
        """Check if Chrome debugging port is available."""
        try:
            response = httpx.get(
                f"http://127.0.0.1:{self.chrome_port}/json",
                timeout=2.0
            )
            pages = response.json()
            return any("aistudio.google.com" in (p.get("url", "") or "") for p in pages)
        except:
            return False
    
    def start(self, wait: bool = True, timeout: float = 10.0) -> bool:
        """
        Start the controller server.
        
        Args:
            wait: Wait for controller to be ready
            timeout: Max seconds to wait
            
        Returns:
            True if started successfully
            
        Raises:
            RuntimeError: If Chrome is not ready or startup fails
        """
        if self.is_running():
            print("✅ Controller already running")
            return True
        
        # Check Chrome
        if not self.is_chrome_ready():
            raise RuntimeError(
                "Chrome not ready. Please:\n"
                "1. Start Chrome with: chrome --remote-debugging-port=9222\n"
                "2. Open https://aistudio.google.com and log in"
            )
        
        node = self._find_node()
        
        # Start controller process
        print(f"🚀 Starting LotL Controller on port {self.port}...")
        
        # Set up environment
        env = os.environ.copy()
        env["PORT"] = str(self.port)
        
        # Start process
        self.process = subprocess.Popen(
            [node, str(self.controller_path)],
            cwd=str(self.controller_path.parent),
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if sys.platform == "win32" else 0
        )
        
        if wait:
            start_time = time.time()
            while time.time() - start_time < timeout:
                if self.is_running():
                    print(f"✅ Controller running on http://localhost:{self.port}")
                    return True
                time.sleep(0.5)
            
            # Timeout - check if process died
            if self.process.poll() is not None:
                output = self.process.stdout.read().decode() if self.process.stdout else ""
                raise RuntimeError(f"Controller failed to start:\n{output}")
            
            raise TimeoutError(f"Controller did not start within {timeout}s")
        
        return True
    
    def stop(self):
        """Stop the controller server."""
        if self.process:
            print("🛑 Stopping controller...")
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
            self.process = None
            print("✅ Controller stopped")
    
    def restart(self):
        """Restart the controller server."""
        self.stop()
        time.sleep(1)
        self.start()
    
    def __enter__(self):
        """Context manager entry."""
        self.start()
        return self
    
    def __exit__(self, exc_type, exc_val, exc_tb):
        """Context manager exit."""
        self.stop()
    
    def __del__(self):
        """Cleanup on deletion."""
        if self.process:
            self.stop()


def start_chrome(
    port: int = 9222,
    user_data_dir: Optional[str] = None
) -> subprocess.Popen:
    """
    Start Chrome with remote debugging enabled.
    
    Args:
        port: Debugging port (default: 9222)
        user_data_dir: Chrome profile directory (default: temp dir)
        
    Returns:
        Chrome subprocess
    """
    if user_data_dir is None:
        import tempfile
        user_data_dir = str(Path(tempfile.gettempdir()) / "chrome-lotl")
    
    # Find Chrome
    chrome_paths = [
        "chrome",
        "google-chrome",
        "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
        "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ]
    
    chrome = None
    for path in chrome_paths:
        if shutil.which(path):
            chrome = path
            break
        if Path(path).exists():
            chrome = path
            break
    
    if not chrome:
        raise FileNotFoundError("Chrome not found. Please install Google Chrome.")
    
    print(f"🌐 Starting Chrome with debugging on port {port}...")
    
    args = [
        chrome,
        f"--remote-debugging-port={port}",
        f"--user-data-dir={user_data_dir}",
        "https://aistudio.google.com"
    ]
    
    process = subprocess.Popen(args)
    print(f"✅ Chrome started. Please log in to AI Studio.")
    
    return process
