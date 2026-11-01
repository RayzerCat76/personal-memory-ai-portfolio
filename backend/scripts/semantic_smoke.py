from __future__ import annotations

import sys
from pathlib import Path
from tempfile import TemporaryDirectory

# Allow this file to be run directly from backend/ with:
#   python scripts/semantic_smoke.py
BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.service import MemoryService
from app.settings import Settings


def confirm_first(service: MemoryService, text: str):
    response = service.ingest_message(text)
    if not response.candidate_memories:
        raise RuntimeError(f"No memory extracted from: {text}")
    memory = response.candidate_memories[0]
    return service.confirm_memory(memory.id)


def main() -> None:
    print("Personal Memory AI — semantic retrieval smoke test")
    print("Embedding provider: Ollama / qwen3-embedding:0.6b\n")

    with TemporaryDirectory(prefix="personal-memory-ai-semantic-") as tmp:
        root = Path(tmp)
        settings = Settings(
            db_path=root / "smoke.db",
            vector_path=root / "vectors",
            llm_provider="heuristic",
            embedding_provider="ollama",
            embedding_model="qwen3-embedding:0.6b",
            ollama_url="http://127.0.0.1:11434",
            max_retrieval=6,
            semantic_retrieval=6,
        )
        service = MemoryService(settings)

        confirm_first(service, "I love Formula 1.")
        target = confirm_first(
            service,
            "I prefer software roles over mechanical roles in robotics projects.",
        )
        confirm_first(service, "I want to visit Japan next summer.")

        query = "Which kind of work suited me better?"
        lexical = service.db.search_confirmed(query, limit=6)
        retrieved = service.retrieve(query)

        print(f"Query: {query}")
        print("\nLexical-only results:")
        if lexical:
            for memory in lexical:
                print(f"  - {memory.content}")
        else:
            print("  (none)")

        print("\nHybrid retrieval results:")
        for index, memory in enumerate(retrieved, start=1):
            marker = "  <-- expected" if memory.id == target.id else ""
            print(f"  {index}. {memory.content}{marker}")

        if service.semantic_error:
            raise RuntimeError(f"Semantic layer error: {service.semantic_error}")
        if not retrieved or retrieved[0].id != target.id:
            raise RuntimeError(
                "Semantic retrieval did not rank the expected robotics/software memory first."
            )

        print("\nPASS: the relevant memory was recovered semantically and ranked first.")

        if service.semantic is not None:
            service.semantic.client.close()


if __name__ == "__main__":
    main()
