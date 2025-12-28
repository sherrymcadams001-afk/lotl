"""
LotL Client - Simple Python interface for the LotL Controller API

Usage:
    from lotl_client import LotLClient
    
    client = LotLClient()
    
    # Simple text prompt
    response = client.chat("What is 2 + 2?")
    print(response)  # "4"
    
    # With image
    response = client.chat("Describe this image", images=["screenshot.png"])
    print(response)
    
    # Async version
    response = await client.achat("Hello")
"""

import base64
import httpx
from pathlib import Path
from typing import Union, Optional


class LotLClient:
    """
    Client for the LotL (Living-off-the-Land) Controller API.
    
    Routes prompts through a logged-in Google AI Studio session
    to bypass API quotas and rate limits.
    """
    
    def __init__(
        self,
        base_url: str = "http://localhost:3000",
        timeout: float = 180.0
    ):
        """
        Initialize the LotL client.
        
        Args:
            base_url: Controller URL (default: http://localhost:3000)
            timeout: Request timeout in seconds (default: 180)
        """
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
    
    def _encode_image(self, image: Union[str, bytes, Path]) -> str:
        """
        Encode an image to base64 data URL.
        
        Args:
            image: File path, bytes, or existing base64 string
            
        Returns:
            Base64 data URL string
        """
        # Already a data URL
        if isinstance(image, str) and image.startswith("data:image"):
            return image
        
        # File path
        if isinstance(image, (str, Path)):
            path = Path(image)
            if not path.exists():
                raise FileNotFoundError(f"Image not found: {path}")
            
            # Detect MIME type
            suffix = path.suffix.lower()
            mime_types = {
                ".png": "image/png",
                ".jpg": "image/jpeg",
                ".jpeg": "image/jpeg",
                ".gif": "image/gif",
                ".webp": "image/webp"
            }
            mime = mime_types.get(suffix, "image/png")
            
            with open(path, "rb") as f:
                b64 = base64.b64encode(f.read()).decode()
            
            return f"data:{mime};base64,{b64}"
        
        # Raw bytes
        if isinstance(image, bytes):
            b64 = base64.b64encode(image).decode()
            return f"data:image/png;base64,{b64}"
        
        raise ValueError(f"Unsupported image type: {type(image)}")
    
    def health(self) -> dict:
        """
        Check if the controller is running.
        
        Returns:
            Health status dict with 'status' and 'message' keys
            
        Raises:
            ConnectionError: If controller is not reachable
        """
        try:
            with httpx.Client(timeout=5.0) as client:
                response = client.get(f"{self.base_url}/health")
                return response.json()
        except httpx.ConnectError:
            raise ConnectionError(
                "Cannot connect to LotL Controller. "
                "Is it running on localhost:3000?"
            )
    
    def is_available(self) -> bool:
        """Check if the controller is available."""
        try:
            health = self.health()
            return health.get("status") == "ok"
        except:
            return False
    
    def chat(
        self,
        prompt: str,
        images: Optional[list] = None,
        timeout: Optional[float] = None
    ) -> str:
        """
        Send a prompt to AI Studio and get a response.
        
        Args:
            prompt: The text prompt to send
            images: Optional list of image paths, bytes, or base64 strings
            timeout: Override default timeout (seconds)
            
        Returns:
            The AI model's response text
            
        Raises:
            ConnectionError: If controller is not reachable
            RuntimeError: If AI Studio returns an error
        """
        payload = {"prompt": prompt}
        
        if images:
            payload["images"] = [self._encode_image(img) for img in images]
        
        try:
            with httpx.Client(timeout=timeout or self.timeout) as client:
                response = client.post(
                    f"{self.base_url}/chat",
                    json=payload
                )
                data = response.json()
                
                if data.get("success"):
                    return data["reply"]
                else:
                    raise RuntimeError(data.get("error", "Unknown error"))
                    
        except httpx.ConnectError:
            raise ConnectionError(
                "Cannot connect to LotL Controller. "
                "Is it running on localhost:3000?"
            )
        except httpx.TimeoutException:
            raise TimeoutError(
                f"Request timed out after {timeout or self.timeout}s. "
                "Try increasing the timeout or check AI Studio."
            )
    
    async def achat(
        self,
        prompt: str,
        images: Optional[list] = None,
        timeout: Optional[float] = None
    ) -> str:
        """
        Async version of chat().
        
        Args:
            prompt: The text prompt to send
            images: Optional list of image paths, bytes, or base64 strings
            timeout: Override default timeout (seconds)
            
        Returns:
            The AI model's response text
        """
        payload = {"prompt": prompt}
        
        if images:
            payload["images"] = [self._encode_image(img) for img in images]
        
        try:
            async with httpx.AsyncClient(timeout=timeout or self.timeout) as client:
                response = await client.post(
                    f"{self.base_url}/chat",
                    json=payload
                )
                data = response.json()
                
                if data.get("success"):
                    return data["reply"]
                else:
                    raise RuntimeError(data.get("error", "Unknown error"))
                    
        except httpx.ConnectError:
            raise ConnectionError(
                "Cannot connect to LotL Controller. "
                "Is it running on localhost:3000?"
            )
        except httpx.TimeoutException:
            raise TimeoutError(
                f"Request timed out after {timeout or self.timeout}s. "
                "Try increasing the timeout or check AI Studio."
            )
    
    def __repr__(self) -> str:
        return f"LotLClient(base_url='{self.base_url}', timeout={self.timeout})"


# Convenience function for quick usage
def ask(prompt: str, images: Optional[list] = None) -> str:
    """
    Quick function to send a prompt to LotL.
    
    Args:
        prompt: The text prompt
        images: Optional list of image paths
        
    Returns:
        AI response text
        
    Example:
        from lotl_client import ask
        print(ask("What is the capital of France?"))
    """
    client = LotLClient()
    return client.chat(prompt, images)


# Module-level client instance for simple usage
_default_client: Optional[LotLClient] = None


def get_client() -> LotLClient:
    """Get or create the default LotL client instance."""
    global _default_client
    if _default_client is None:
        _default_client = LotLClient()
    return _default_client


if __name__ == "__main__":
    # Quick test
    client = LotLClient()
    
    print("Testing LotL Client...")
    print(f"Controller available: {client.is_available()}")
    
    if client.is_available():
        response = client.chat("Say 'Hello from LotL Client!' and nothing else.")
        print(f"Response: {response}")
