from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_prefix="PERSONAL_AI_",
        extra="ignore",
    )

    db_path: Path = Path("./data/personal_ai.db")
    vector_path: Path = Path("./data/vectors")
    friend_seed_path: Path = Path("./data/friend_seed.json")
    friend_seed_feedback_path: Path = Path("./data/friend_seed_feedback.json")

    llm_provider: str = "heuristic"
    mlx_model: str = "mlx-community/Qwen3-4B-4bit"
    mlx_extraction_thinking: bool | None = None

    # Semantic retrieval is the normal local mode. If Ollama is unavailable,
    # MemoryService records the error and safely falls back to lexical search.
    embedding_provider: str = "ollama"
    ollama_url: str = "http://127.0.0.1:11434"
    embedding_model: str = "qwen3-embedding:0.6b"

    max_retrieval: int = 6
    semantic_retrieval: int = 8


@lru_cache
def get_settings() -> Settings:
    return Settings()
