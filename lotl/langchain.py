"""
LotL LangChain Integration - LangChain-compatible ChatModel wrapper

This provides a LangChain BaseChatModel that routes through the LotL controller.
Can be used as a drop-in replacement for any LangChain chat model.
"""

import json
from typing import Any, Iterator, List, Optional, Type, TypeVar

try:
    from langchain_core.language_models.chat_models import BaseChatModel
    from langchain_core.messages import (
        AIMessage,
        BaseMessage,
        HumanMessage,
        SystemMessage,
    )
    from langchain_core.outputs import ChatGeneration, ChatResult
    from langchain_core.callbacks import CallbackManagerForLLMRun
    from pydantic import BaseModel, Field
    LANGCHAIN_AVAILABLE = True
except ImportError:
    LANGCHAIN_AVAILABLE = False
    BaseChatModel = object
    BaseModel = object
    
import httpx

T = TypeVar('T', bound='BaseModel')


def _check_langchain():
    """Raise if LangChain not installed."""
    if not LANGCHAIN_AVAILABLE:
        raise ImportError(
            "LangChain not installed. Install with:\n"
            "  pip install lotl[langchain]\n"
            "or:\n"
            "  pip install langchain-core"
        )


class ChatLotL(BaseChatModel if LANGCHAIN_AVAILABLE else object):
    """
    LangChain-compatible chat model that uses the LotL controller.
    
    Routes prompts through a logged-in AI Studio session via Chrome.
    
    Examples:
        from lotl.langchain import ChatLotL
        
        llm = ChatLotL()
        response = llm.invoke("What is 2+2?")
        print(response.content)
        
        # With images
        from langchain_core.messages import HumanMessage
        response = llm.invoke([
            HumanMessage(content=[
                {"type": "text", "text": "What's in this image?"},
                {"type": "image_url", "image_url": {"url": "data:image/png;base64,..."}}
            ])
        ])
    """
    
    model: str = "gemini-lotl"
    endpoint: str = "http://localhost:3000/aistudio"
    timeout: int = 300
    
    def __init__(self, **kwargs):
        _check_langchain()
        super().__init__(**kwargs)
    
    @property
    def _llm_type(self) -> str:
        return "lotl"
    
    @property
    def _identifying_params(self) -> dict:
        return {"model": self.model, "endpoint": self.endpoint}
    
    def _serialize_messages(self, messages: List[BaseMessage]) -> tuple:
        """Convert LangChain messages to prompt + images."""
        parts = []
        images = []
        
        for msg in messages:
            content = msg.content
            
            if isinstance(msg, SystemMessage):
                parts.append(f"[SYSTEM] {content}")
            elif isinstance(msg, HumanMessage):
                if isinstance(content, list):
                    # Multimodal content
                    for item in content:
                        if isinstance(item, dict):
                            if item.get("type") == "text":
                                parts.append(item["text"])
                            elif item.get("type") == "image_url":
                                url = item.get("image_url", {}).get("url", "")
                                if url.startswith("data:image"):
                                    images.append(url)
                        elif isinstance(item, str):
                            parts.append(item)
                else:
                    parts.append(str(content))
            elif isinstance(msg, AIMessage):
                parts.append(f"[Assistant] {content}")
            else:
                parts.append(str(content))
        
        return "\n".join(parts), images
    
    def _generate(
        self,
        messages: List[BaseMessage],
        stop: Optional[List[str]] = None,
        run_manager: Optional[CallbackManagerForLLMRun] = None,
        **kwargs: Any
    ) -> ChatResult:
        """Synchronous generation."""
        prompt, images = self._serialize_messages(messages)
        
        payload = {"prompt": prompt}
        if images:
            payload["images"] = images
        
        try:
            response = httpx.post(
                self.endpoint,
                json=payload,
                timeout=self.timeout
            )
            response.raise_for_status()
            data = response.json()
            
            if not data.get("success"):
                error = data.get("error", "Unknown error")
                raise RuntimeError(f"LotL error: {error}")
            
            reply = data.get("reply", "")
            
        except httpx.ConnectError:
            raise RuntimeError(
                "Cannot connect to LotL controller. "
                "Start it with: lotl.start_controller()"
            )
        except httpx.TimeoutException:
            raise RuntimeError(f"LotL request timed out after {self.timeout}s")
        
        message = AIMessage(content=reply)
        generation = ChatGeneration(message=message)
        
        return ChatResult(
            generations=[generation],
            llm_output={
                "model": self.model,
                "token_usage": {
                    "prompt_tokens": len(prompt) // 4,
                    "completion_tokens": len(reply) // 4,
                    "total_tokens": (len(prompt) + len(reply)) // 4
                }
            }
        )
    
    async def _agenerate(
        self,
        messages: List[BaseMessage],
        stop: Optional[List[str]] = None,
        run_manager: Optional[CallbackManagerForLLMRun] = None,
        **kwargs: Any
    ) -> ChatResult:
        """Asynchronous generation."""
        prompt, images = self._serialize_messages(messages)
        
        payload = {"prompt": prompt}
        if images:
            payload["images"] = images
        
        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                response = await client.post(
                    self.endpoint,
                    json=payload
                )
                response.raise_for_status()
                data = response.json()
            
            if not data.get("success"):
                error = data.get("error", "Unknown error")
                raise RuntimeError(f"LotL error: {error}")
            
            reply = data.get("reply", "")
            
        except httpx.ConnectError:
            raise RuntimeError(
                "Cannot connect to LotL controller. "
                "Start it with: await lotl.astart_controller()"
            )
        except httpx.TimeoutException:
            raise RuntimeError(f"LotL request timed out after {self.timeout}s")
        
        message = AIMessage(content=reply)
        generation = ChatGeneration(message=message)
        
        return ChatResult(
            generations=[generation],
            llm_output={
                "model": self.model,
                "token_usage": {
                    "prompt_tokens": len(prompt) // 4,
                    "completion_tokens": len(reply) // 4,
                    "total_tokens": (len(prompt) + len(reply)) // 4
                }
            }
        )
    
    def with_structured_output(self, schema: Type[T]) -> "StructuredLotL":
        """
        Return a wrapper that parses output into a Pydantic model.
        
        Args:
            schema: Pydantic model class
            
        Returns:
            Wrapper that returns instances of schema
        """
        return StructuredLotL(llm=self, schema=schema)


class StructuredLotL:
    """Wrapper for structured output parsing."""
    
    def __init__(self, llm: ChatLotL, schema: Type[T]):
        self.llm = llm
        self.schema = schema
    
    def _extract_json(self, text: str) -> dict:
        """Extract JSON from response."""
        text = text.strip()
        
        # Remove markdown
        if text.startswith("```json"):
            text = text[7:]
        elif text.startswith("```"):
            text = text[3:]
        if text.endswith("```"):
            text = text[:-3]
        
        text = text.strip()
        
        # Find JSON
        obj_start = text.find("{")
        arr_start = text.find("[")
        
        if obj_start == -1 and arr_start == -1:
            raise ValueError(f"No JSON found in response: {text[:200]}")
        
        if obj_start == -1:
            start, end_char = arr_start, "]"
        elif arr_start == -1:
            start, end_char = obj_start, "}"
        else:
            start = min(obj_start, arr_start)
            end_char = "}" if start == obj_start else "]"
        
        end = text.rfind(end_char)
        if end <= start:
            raise ValueError(f"Malformed JSON in response: {text[:200]}")
        
        return json.loads(text[start:end+1])
    
    def invoke(self, messages: List[BaseMessage], **kwargs) -> T:
        """Invoke and parse response."""
        # Add schema hint
        if isinstance(messages, str):
            messages = [HumanMessage(content=messages)]
        
        # Request JSON format
        hint = f"\n\nRespond with valid JSON matching this schema:\n{self.schema.model_json_schema()}"
        if messages and isinstance(messages[-1], HumanMessage):
            content = messages[-1].content
            if isinstance(content, str):
                messages[-1] = HumanMessage(content=content + hint)
        
        result = self.llm.invoke(messages, **kwargs)
        data = self._extract_json(result.content)
        return self.schema.model_validate(data)
    
    async def ainvoke(self, messages: List[BaseMessage], **kwargs) -> T:
        """Async invoke and parse response."""
        if isinstance(messages, str):
            messages = [HumanMessage(content=messages)]
        
        hint = f"\n\nRespond with valid JSON matching this schema:\n{self.schema.model_json_schema()}"
        if messages and isinstance(messages[-1], HumanMessage):
            content = messages[-1].content
            if isinstance(content, str):
                messages[-1] = HumanMessage(content=content + hint)
        
        result = await self.llm.ainvoke(messages, **kwargs)
        data = self._extract_json(result.content)
        return self.schema.model_validate(data)


def get_lotl_llm(
    endpoint: str = "http://localhost:3000/chat",
    timeout: int = 300
) -> ChatLotL:
    """
    Create a LangChain-compatible LotL chat model.
    
    Args:
        endpoint: Controller endpoint URL
        timeout: Request timeout in seconds
        
    Returns:
        ChatLotL instance
        
    Example:
        from lotl import get_lotl_llm
        
        llm = get_lotl_llm()
        response = llm.invoke("Hello!")
    """
    return ChatLotL(endpoint=endpoint, timeout=timeout)


# Also export for browser-use compatibility
__all__ = ["ChatLotL", "StructuredLotL", "get_lotl_llm", "LANGCHAIN_AVAILABLE"]
