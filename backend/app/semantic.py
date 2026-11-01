from __future__ import annotations

import hashlib
import math
import re
import uuid
from pathlib import Path
from typing import Protocol

import httpx
from qdrant_client import QdrantClient, models

from .schemas import MemoryRead


class EmbeddingProvider(Protocol):
    def embed(self, texts: list[str]) -> list[list[float]]: ...


class OllamaEmbeddingProvider:
    """Embedding provider backed by a local Ollama server."""

    def __init__(
        self,
        model: str = "qwen3-embedding:0.6b",
        base_url: str = "http://127.0.0.1:11434",
        timeout_seconds: float = 120.0,
    ):
        self.model = model
        self.base_url = base_url.rstrip("/")
        self.timeout_seconds = timeout_seconds

    def embed(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        response = httpx.post(
            f"{self.base_url}/api/embed",
            json={"model": self.model, "input": texts},
            timeout=self.timeout_seconds,
        )
        response.raise_for_status()
        payload = response.json()
        embeddings = payload.get("embeddings")
        if not isinstance(embeddings, list) or len(embeddings) != len(texts):
            raise RuntimeError("Ollama returned an invalid embedding response")
        return embeddings


class HashEmbeddingProvider:
    """Tiny deterministic embedding provider used only by tests.

    It is a feature-hashing bag-of-words representation. It proves the vector
    storage/retrieval plumbing without requiring a model download or network
    access. Production semantic retrieval should use OllamaEmbeddingProvider.
    """

    def __init__(self, dimensions: int = 256):
        self.dimensions = dimensions

    def embed(self, texts: list[str]) -> list[list[float]]:
        return [self._embed_one(text) for text in texts]

    def _embed_one(self, text: str) -> list[float]:
        vector = [0.0] * self.dimensions
        for token in re.findall(r"[\w-]+", text.lower(), flags=re.UNICODE):
            digest = hashlib.blake2b(token.encode("utf-8"), digest_size=8).digest()
            value = int.from_bytes(digest, "big")
            index = value % self.dimensions
            sign = 1.0 if ((value >> 8) & 1) == 0 else -1.0
            vector[index] += sign
        norm = math.sqrt(sum(value * value for value in vector))
        if norm > 0:
            vector = [value / norm for value in vector]
        return vector


class SemanticMemoryIndex:
    """Local Qdrant index whose payloads point back to SQLite memory IDs."""

    def __init__(
        self,
        path: Path,
        provider: EmbeddingProvider,
        collection_name: str = "personal_memories",
    ):
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.provider = provider
        self.collection_name = collection_name
        self.client = QdrantClient(path=str(path))

    @staticmethod
    def _point_id(memory_id: str) -> str:
        return str(uuid.uuid5(uuid.NAMESPACE_URL, f"personal-memory-ai:{memory_id}"))

    def _ensure_collection(self, vector_size: int) -> None:
        if self.client.collection_exists(self.collection_name):
            return
        self.client.create_collection(
            collection_name=self.collection_name,
            vectors_config=models.VectorParams(
                size=vector_size,
                distance=models.Distance.COSINE,
            ),
        )

    def is_indexed(self, memory_id: str) -> bool:
        if not self.client.collection_exists(self.collection_name):
            return False
        points = self.client.retrieve(
            collection_name=self.collection_name,
            ids=[self._point_id(memory_id)],
            with_payload=False,
            with_vectors=False,
        )
        return bool(points)

    def upsert(self, memory: MemoryRead) -> None:
        vector = self.provider.embed([memory.content])[0]
        self._ensure_collection(len(vector))
        self.client.upsert(
            collection_name=self.collection_name,
            points=[
                models.PointStruct(
                    id=self._point_id(memory.id),
                    vector=vector,
                    payload={
                        "memory_id": memory.id,
                        "type": memory.type,
                        "importance": memory.importance,
                    },
                )
            ],
        )

    def ensure_indexed(self, memories: list[MemoryRead]) -> None:
        missing = [memory for memory in memories if not self.is_indexed(memory.id)]
        if not missing:
            return
        vectors = self.provider.embed([memory.content for memory in missing])
        self._ensure_collection(len(vectors[0]))
        points = []
        for memory, vector in zip(missing, vectors, strict=True):
            points.append(
                models.PointStruct(
                    id=self._point_id(memory.id),
                    vector=vector,
                    payload={
                        "memory_id": memory.id,
                        "type": memory.type,
                        "importance": memory.importance,
                    },
                )
            )
        self.client.upsert(collection_name=self.collection_name, points=points)

    def delete(self, memory_id: str) -> None:
        if not self.client.collection_exists(self.collection_name):
            return
        self.client.delete(
            collection_name=self.collection_name,
            points_selector=models.PointIdsList(points=[self._point_id(memory_id)]),
        )

    def search(self, query: str, limit: int = 6) -> list[tuple[str, float]]:
        if not query.strip() or not self.client.collection_exists(self.collection_name):
            return []
        vector = self.provider.embed([query])[0]
        result = self.client.query_points(
            collection_name=self.collection_name,
            query=vector,
            limit=limit,
            with_payload=True,
        )
        output: list[tuple[str, float]] = []
        for point in result.points:
            payload = point.payload or {}
            memory_id = payload.get("memory_id")
            if isinstance(memory_id, str):
                output.append((memory_id, float(point.score)))
        return output


def build_embedding_provider(
    provider_name: str,
    *,
    ollama_model: str,
    ollama_url: str,
) -> EmbeddingProvider | None:
    provider_name = provider_name.strip().lower()
    if provider_name in {"", "none", "disabled"}:
        return None
    if provider_name == "hash":
        return HashEmbeddingProvider()
    if provider_name == "ollama":
        return OllamaEmbeddingProvider(model=ollama_model, base_url=ollama_url)
    raise ValueError(f"Unknown embedding provider: {provider_name}")
