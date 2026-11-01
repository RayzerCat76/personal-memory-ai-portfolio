"""Small, disposable demonstration of the confirmed-memory trust boundary."""

from pathlib import Path
from tempfile import TemporaryDirectory

from app.service import MemoryService
from app.settings import Settings


def main() -> None:
    with TemporaryDirectory(prefix="personal-memory-demo-") as directory:
        root = Path(directory)
        service = MemoryService(
            Settings(
                db_path=root / "demo.db",
                vector_path=root / "vectors",
                llm_provider="heuristic",
                embedding_provider="none",
                max_retrieval=6,
            )
        )
        candidate = service.ingest_message(
            "I prefer Python over Java for personal projects."
        ).candidate_memories[0]
        question = "Do I prefer Python or Java?"
        before = service.chat(question)
        service.db.set_status(candidate.id, "confirmed")
        after = service.chat(question)

        print("Candidate status before approval:", candidate.status)
        print("Evidence before approval:", len(before.evidence))
        print("Evidence after approval:", len(after.evidence))
        print("Answer after approval:", after.answer)
        print("The demonstration used a temporary database and no model download.")


if __name__ == "__main__":
    main()
