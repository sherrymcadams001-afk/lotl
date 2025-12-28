"""
LotL - Living off the Land AI Controller

Route AI prompts through a logged-in Google AI Studio session
to bypass API quotas and rate limits.

Usage:
    from lotl import LotL
    
    # Simple usage
    response = LotL.ask("What is 2 + 2?")
    
    # With images
    response = LotL.ask("Describe this", images=["screenshot.png"])
    
    # Client instance for more control
    client = LotL()
    client.chat("Hello")
    
    # Async
    response = await LotL.aask("Hello")
"""

from .client import LotLClient, ask, aask, get_client
from .controller import LotLController
from .langchain import ChatLotL, get_lotl_llm

__version__ = "2.0.0"
__all__ = [
    "LotLClient",
    "LotLController", 
    "ChatLotL",
    "get_lotl_llm",
    "ask",
    "aask",
    "get_client",
]


# Convenience class for simple usage
class LotL:
    """
    Convenience class for quick LotL usage.
    
    Examples:
        # One-liner
        response = LotL.ask("What is Python?")
        
        # With image
        response = LotL.ask("Describe this", images=["img.png"])
        
        # Check if available
        if LotL.available():
            response = LotL.ask("Hello")
        
        # Start controller (requires Node.js)
        LotL.start_controller()
    """
    
    _client = None
    _controller = None
    
    @classmethod
    def _get_client(cls) -> LotLClient:
        if cls._client is None:
            cls._client = LotLClient()
        return cls._client
    
    @classmethod
    def ask(cls, prompt: str, images: list = None, timeout: float = None) -> str:
        """Send a prompt and get a response."""
        return cls._get_client().chat(prompt, images, timeout)
    
    @classmethod
    async def aask(cls, prompt: str, images: list = None, timeout: float = None) -> str:
        """Async version of ask()."""
        return await cls._get_client().achat(prompt, images, timeout)
    
    @classmethod
    def available(cls) -> bool:
        """Check if LotL controller is running and accessible."""
        return cls._get_client().is_available()
    
    @classmethod
    def health(cls) -> dict:
        """Get controller health status."""
        return cls._get_client().health()
    
    @classmethod
    def start_controller(cls, wait: bool = True) -> "LotLController":
        """
        Start the LotL controller server.
        
        Args:
            wait: If True, wait for controller to be ready
            
        Returns:
            LotLController instance
        """
        if cls._controller is None:
            cls._controller = LotLController()
        cls._controller.start(wait=wait)
        return cls._controller
    
    @classmethod
    def stop_controller(cls):
        """Stop the LotL controller server."""
        if cls._controller:
            cls._controller.stop()
    
    @classmethod
    def get_langchain_llm(cls):
        """Get a LangChain-compatible LLM instance."""
        return get_lotl_llm()
