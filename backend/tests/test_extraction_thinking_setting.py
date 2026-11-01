import sys
from types import SimpleNamespace
from unittest.mock import Mock, patch

from app.llm import MLXProvider
from app.service import MemoryService
from app.settings import Settings


def test_default_retains_tokenizer_behavior():
    provider = MLXProvider("unused")
    provider._model = object()
    template = Mock(return_value="assistant\n")
    provider._tokenizer = SimpleNamespace(apply_chat_template=template)
    with patch.dict(sys.modules, {"mlx_lm": SimpleNamespace(generate=lambda *a, **kw: "[]")}):
        assert provider.extract_memories("Thanks!") == []
    assert "enable_thinking" not in template.call_args.kwargs


def test_opt_in_only_changes_extraction_template_not_chat():
    provider = MLXProvider("unused", extraction_thinking=False)
    provider._model = object()
    template = Mock(return_value="assistant\n<think>\n\n</think>\n\n")
    provider._tokenizer = SimpleNamespace(apply_chat_template=template)
    generate = Mock(return_value="[]")
    stream = Mock(return_value=iter([SimpleNamespace(text="You play cello.", finish_reason="stop")]))
    with patch.dict(sys.modules, {"mlx_lm": SimpleNamespace(generate=generate, stream_generate=stream)}):
        assert provider.extract_memories("Thanks!") == []
        assert template.call_args.kwargs["enable_thinking"] is False
        assert generate.call_args.kwargs["max_tokens"] == 450
        memory = SimpleNamespace(id="test", content="I play cello.", source_type="user_statement", confidence_label="CONFIRMED")
        assert provider.answer("What instrument?", [memory]) == "You play cello."
        assert "enable_thinking" not in template.call_args.kwargs
        assert stream.call_args.kwargs["max_tokens"] == 700


def test_process_setting_reaches_provider_without_loading_model(tmp_path):
    with patch.dict("os.environ", {"PERSONAL_AI_MLX_EXTRACTION_THINKING": "false"}):
        settings = Settings(db_path=tmp_path / "test.db", llm_provider="mlx", embedding_provider="none")
    service = MemoryService(settings)
    assert service.llm.extraction_thinking is False
    assert service.llm._model is None
    assert Settings(_env_file=None).mlx_extraction_thinking is None
