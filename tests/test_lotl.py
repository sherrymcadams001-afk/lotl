"""
Tests for the LotL package.
"""

import pytest
from unittest.mock import patch, MagicMock
import json


class TestLotLClient:
    """Tests for LotLClient."""
    
    def test_import(self):
        """Test that the package imports correctly."""
        from lotl import LotLClient, LotL, get_lotl_llm
        assert LotLClient is not None
        assert LotL is not None
        assert get_lotl_llm is not None
    
    def test_client_init(self):
        """Test client initialization."""
        from lotl import LotLClient
        
        client = LotLClient()
        assert client.endpoint == "http://localhost:3000/aistudio"
        assert client.timeout == 300.0
        
        client2 = LotLClient(endpoint="http://custom:8000/chat", timeout=60)
        assert client2.endpoint == "http://custom:8000/chat"
        assert client2.timeout == 60
    
    def test_image_encoding_path(self, tmp_path):
        """Test image encoding from file path."""
        from lotl.client import LotLClient
        import base64
        
        # Create a test image file
        img_path = tmp_path / "test.png"
        img_data = b'\x89PNG\r\n\x1a\n' + b'\x00' * 100  # Minimal PNG header
        img_path.write_bytes(img_data)
        
        client = LotLClient()
        encoded = client._encode_image(str(img_path))
        
        assert encoded.startswith("data:image/png;base64,")
        # Verify the base64 decodes correctly
        b64_part = encoded.split(",", 1)[1]
        decoded = base64.b64decode(b64_part)
        assert decoded == img_data
    
    def test_image_encoding_bytes(self):
        """Test image encoding from bytes."""
        from lotl.client import LotLClient
        import base64
        
        img_data = b'\x89PNG\r\n\x1a\n' + b'\x00' * 50
        
        client = LotLClient()
        encoded = client._encode_image(img_data)
        
        assert encoded.startswith("data:image/png;base64,")
        b64_part = encoded.split(",", 1)[1]
        decoded = base64.b64decode(b64_part)
        assert decoded == img_data
    
    def test_image_encoding_passthrough(self):
        """Test that already-encoded images pass through."""
        from lotl.client import LotLClient
        
        already_encoded = "data:image/png;base64,iVBORw0KGgo="
        
        client = LotLClient()
        result = client._encode_image(already_encoded)
        
        assert result == already_encoded
    
    @patch('lotl.client.httpx.Client')
    def test_chat_success(self, mock_client_cls):
        """Test successful chat request."""
        from lotl.client import LotLClient

        mock_client = MagicMock()
        mock_client_cls.return_value.__enter__.return_value = mock_client

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.raise_for_status.return_value = None
        mock_response.json.return_value = {"success": True, "reply": "Hello, world!"}
        mock_client.post.return_value = mock_response
        
        client = LotLClient()
        result = client.chat("Hello")
        
        assert result == "Hello, world!"
        mock_client.post.assert_called_once()
    
    @patch('lotl.client.httpx.Client')
    def test_chat_error(self, mock_client_cls):
        """Test error handling in chat."""
        from lotl.client import LotLClient

        mock_client = MagicMock()
        mock_client_cls.return_value.__enter__.return_value = mock_client

        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.raise_for_status.return_value = None
        mock_response.json.return_value = {"success": False, "error": "Something went wrong"}
        mock_client.post.return_value = mock_response
        
        client = LotLClient()
        
        with pytest.raises(RuntimeError) as exc_info:
            client.chat("Hello")
        
        assert "Something went wrong" in str(exc_info.value)


class TestLotLConvenience:
    """Tests for the LotL convenience class."""
    
    def test_ask_method_exists(self):
        """Test that LotL.ask exists."""
        from lotl import LotL
        
        assert hasattr(LotL, 'ask')
        assert hasattr(LotL, 'aask')
        assert hasattr(LotL, 'available')
        assert hasattr(LotL, 'health')
        assert hasattr(LotL, 'start_controller')
        assert hasattr(LotL, 'get_langchain_llm')


class TestController:
    """Tests for LotLController."""
    
    def test_controller_import(self):
        """Test controller imports."""
        from lotl.controller import LotLController, start_chrome
        assert LotLController is not None
        assert start_chrome is not None
    
    def test_controller_init(self):
        """Test controller initialization."""
        from lotl.controller import LotLController
        
        # This should fail gracefully when controller script not found
        with pytest.raises(FileNotFoundError):
            ctrl = LotLController(controller_path="/nonexistent/path.js")


class TestLangChain:
    """Tests for LangChain integration."""
    
    def test_langchain_available_flag(self):
        """Test LANGCHAIN_AVAILABLE flag."""
        from lotl.langchain import LANGCHAIN_AVAILABLE
        # Should be True if langchain-core is installed
        assert isinstance(LANGCHAIN_AVAILABLE, bool)
    
    @pytest.mark.skipif(
        not __import__('lotl.langchain', fromlist=['LANGCHAIN_AVAILABLE']).LANGCHAIN_AVAILABLE,
        reason="LangChain not installed"
    )
    def test_chat_lotl_creation(self):
        """Test ChatLotL can be created."""
        from lotl.langchain import ChatLotL
        
        llm = ChatLotL()
        assert llm.model == "gemini-lotl"
        assert llm.endpoint == "http://localhost:3000/aistudio"


class TestCLI:
    """Tests for CLI module."""
    
    def test_cli_import(self):
        """Test CLI imports."""
        from lotl.cli import main
        assert main is not None
    
    def test_cli_commands_exist(self):
        """Test all CLI commands exist."""
        from lotl import cli
        
        assert hasattr(cli, 'cmd_start')
        assert hasattr(cli, 'cmd_stop')
        assert hasattr(cli, 'cmd_status')
        assert hasattr(cli, 'cmd_ask')
        assert hasattr(cli, 'cmd_chrome')


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
