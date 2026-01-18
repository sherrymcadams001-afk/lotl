"""
LotL HTTP Client - Simple interface for the LotL Controller API
"""

import base64
import httpx
from pathlib import Path
from typing import Union, Optional, List
from urllib.parse import urlparse


class LotLClient:
    """
    Client for the LotL (Living-off-the-Land) Controller API.
    
    Routes prompts through a logged-in Google AI Studio session
    to bypass API quotas and rate limits.
    
    Examples:
        client = LotLClient()
        
        # Simple prompt
        response = client.chat("What is 2 + 2?")
        
        # With image
        response = client.chat("Describe this", images=["screenshot.png"])
        
        # Async
        response = await client.achat("Hello")
    """
    
    def __init__(
        self,
        base_url: str = "http://localhost:3000",
        timeout: float = 300.0,
        endpoint: Optional[str] = None
    ):
        """
        Initialize the LotL client.
        
        Args:
            base_url: Controller URL (default: http://localhost:3000)
            timeout: Request timeout in seconds (default: 180)
        """
        self.timeout = timeout

        resolved_base_url = base_url
        primary_path = "/aistudio"

        if endpoint:
            parsed = urlparse(endpoint)
            if parsed.scheme and parsed.netloc:
                resolved_base_url = f"{parsed.scheme}://{parsed.netloc}"
                if parsed.path and parsed.path != "/":
                    primary_path = parsed.path
            else:
                resolved_base_url = endpoint

        self.base_url = resolved_base_url.rstrip("/")
        self._primary_path = primary_path

    @property
    def endpoint(self) -> str:
        """Backward-compatible full endpoint URL string."""
        return f"{self.base_url}{self._primary_path}"

    def _post_chat(self, payload: dict, timeout: float) -> dict:
        """POST to the preferred endpoint, falling back to v3 /aistudio then legacy /chat."""
        with httpx.Client(timeout=timeout) as client:
            candidates = [self._primary_path, "/aistudio", "/chat"]
            seen = set()

            last_response: Optional[httpx.Response] = None
            for path in candidates:
                if path in seen:
                    continue
                seen.add(path)
                last_response = client.post(f"{self.base_url}{path}", json=payload)
                if last_response.status_code == 404:
                    continue
                last_response.raise_for_status()
                return last_response.json()

            if last_response is None:
                raise RuntimeError("No endpoint candidates were attempted")
            last_response.raise_for_status()
            return last_response.json()
    
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
        images: Optional[List[Union[str, bytes, Path]]] = None,
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
            data = self._post_chat(payload, timeout=timeout or self.timeout)

            if data.get("success"):
                return data["reply"]
            else:
                raise RuntimeError(data.get("error", "Unknown error"))
                    
        except httpx.ConnectError:
            raise ConnectionError(
                "Cannot connect to LotL Controller. "
                "Is it running on localhost:3000? "
                "Start it with: lotl start"
            )
        except httpx.TimeoutException:
            raise TimeoutError(
                f"Request timed out after {timeout or self.timeout}s. "
                "Try increasing the timeout or check AI Studio."
            )
    
    async def achat(
        self,
        prompt: str,
        images: Optional[List[Union[str, bytes, Path]]] = None,
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
                response = await client.post(f"{self.base_url}/aistudio", json=payload)
                if response.status_code == 404:
                    response = await client.post(f"{self.base_url}/chat", json=payload)
                response.raise_for_status()
                data = response.json()
                
                if data.get("success"):
                    return data["reply"]
                else:
                    raise RuntimeError(data.get("error", "Unknown error"))
                    
        except httpx.ConnectError:
            raise ConnectionError(
                "Cannot connect to LotL Controller. "
                "Is it running on localhost:3000? "
                "Start it with: lotl start"
            )
        except httpx.TimeoutException:
            raise TimeoutError(
                f"Request timed out after {timeout or self.timeout}s. "
                "Try increasing the timeout or check AI Studio."
            )
    
    def __repr__(self) -> str:
        return f"LotLClient(base_url='{self.base_url}', timeout={self.timeout})"


# Module-level convenience functions
_default_client: Optional[LotLClient] = None


def get_client() -> LotLClient:
    """Get or create the default LotL client instance."""
    global _default_client
    if _default_client is None:
        _default_client = LotLClient()
    return _default_client


def ask(prompt: str, images: Optional[List] = None, timeout: float = None) -> str:
    """
    Quick function to send a prompt to LotL.
    
    Args:
        prompt: The text prompt
        images: Optional list of image paths
        timeout: Request timeout in seconds
        
    Returns:
        AI response text
        
    Example:
        from lotl import ask
        print(ask("What is the capital of France?"))
    """
    return get_client().chat(prompt, images, timeout)


async def aask(prompt: str, images: Optional[List] = None, timeout: float = None) -> str:
    """
    Async version of ask().
    
    Example:
        from lotl import aask
        response = await aask("Hello")
    """
    return await get_client().achat(prompt, images, timeout)
