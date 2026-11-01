from __future__ import annotations

import re

from .schemas import MemoryCandidate, ResolutionCandidate


class HeuristicMemoryExtractor:
    """Deterministic local extractor used for development and tests.

    The rules intentionally favour explicit statements over clever guesses.
    A stronger model can replace this layer later without changing the memory
    lifecycle underneath it.
    """

    def extract(self, text: str) -> list[MemoryCandidate]:
        candidates: list[MemoryCandidate] = []
        for sentence in _sentences(text):
            candidates.extend(self._extract_sentence(sentence))

        seen: set[tuple[str, str]] = set()
        unique: list[MemoryCandidate] = []
        for candidate in candidates:
            key = (candidate.type, _canonical(candidate.content))
            if key not in seen:
                seen.add(key)
                unique.append(candidate)
        return unique[:8]

    def extract_resolutions(self, text: str) -> list[ResolutionCandidate]:
        out: list[ResolutionCandidate] = []
        for sentence in _sentences(text):
            lower = sentence.lower().strip()

            cancelled = [
                r"\bi decided not to (.+)",
                r"\bi(?:'m| am) not going to (.+)",
                r"\bi(?:'m| am) no longer going to (.+)",
                r"\bi cancelled (.+)",
            ]
            for pattern in cancelled:
                match = re.search(pattern, lower, flags=re.IGNORECASE)
                if match:
                    out.append(
                        ResolutionCandidate(
                            target_text=match.group(1).strip(" .!?"),
                            proposed_status="cancelled",
                            confidence=0.96,
                        )
                    )
                    break

            completed = [
                r"\bi (?:have )?sent (.+)",
                r"\bi (?:have )?(?:finished|completed) (.+)",
                r"\bi (?:have )?submitted (.+)",
                r"\bi (?:have )?emailed (.+)",
                r"\bi (?:have )?called (.+)",
                r"\bi (?:have )?booked (.+)",
                r"\bi (?:have )?paid (.+)",
                r"\bi (?:have )?bought (.+)",
            ]
            for pattern in completed:
                match = re.search(pattern, lower, flags=re.IGNORECASE)
                if match:
                    out.append(
                        ResolutionCandidate(
                            target_text=match.group(1).strip(" .!?"),
                            proposed_status="completed",
                            confidence=0.94,
                        )
                    )
                    break

        return out[:5]

    def _extract_sentence(self, sentence: str) -> list[MemoryCandidate]:
        lower = sentence.lower()
        candidates: list[MemoryCandidate] = []

        def add(
            memory_type: str,
            content: str,
            confidence: float,
            importance: float,
            subject: str | None = None,
        ) -> None:
            candidates.append(
                MemoryCandidate(
                    type=memory_type,
                    content=content.strip(),
                    confidence=confidence,
                    source_type="user_statement",
                    importance=importance,
                    subject=_clean_subject(subject),
                )
            )

        match = re.search(r"\bi (?:really )?(?:like|love|enjoy) (.+)", lower, flags=re.IGNORECASE)
        if match:
            thing = _clean_group(match.group(1))
            add("interest", f"Likes {thing}", 0.9, 0.55, thing)

        match = re.search(r"\bi (?:really )?(?:dislike|hate) (.+)", lower, flags=re.IGNORECASE)
        if match:
            thing = _clean_group(match.group(1))
            add("preference", f"Dislikes {thing}", 0.9, 0.55, thing)

        # Support the most common natural comparison phrasings rather than
        # requiring users to learn a special command syntax.
        match = re.search(
            r"\bi prefer (.+?) (?:rather than|instead of|over|to) (.+)",
            lower,
            flags=re.IGNORECASE,
        )
        if match:
            left = _clean_group(match.group(1))
            right = _clean_group(match.group(2))
            subject = " | ".join(sorted([left, right]))
            add("preference", f"Prefers {left} over {right}", 0.95, 0.65, subject)

        match = re.search(r"\bmy favourite (.+?) is (.+)", lower, flags=re.IGNORECASE)
        if match:
            category = _clean_group(match.group(1))
            value = _clean_group(match.group(2))
            add("preference", f"Favourite {category} is {value}", 0.95, 0.7, f"favourite {category}")

        commitment_patterns = [
            r"\bi(?:'m| am) planning to (.+)",
            r"\bi(?:'m| am) going to (.+)",
            r"\bi need to (.+)",
            r"\bi have to (.+)",
        ]
        for pattern in commitment_patterns:
            match = re.search(pattern, lower, flags=re.IGNORECASE)
            if match:
                action = _clean_group(match.group(1))
                add("commitment", f"Plans to {action}", 0.9, 0.7, action)
                break

        match = re.search(r"\bi (?:want|hope) to (.+)", lower, flags=re.IGNORECASE)
        if match:
            action = _clean_group(match.group(1))
            add("goal", f"Wants to {action}", 0.84, 0.62, action)

        match = re.search(r"\bi might (.+)", lower, flags=re.IGNORECASE)
        if match:
            action = _clean_group(match.group(1))
            add("goal", f"Considering {action}", 0.68, 0.5, action)

        match = re.search(r"\bi decided to (.+)", lower, flags=re.IGNORECASE)
        if match:
            action = _clean_group(match.group(1))
            add("decision", f"Decided to {action}", 0.97, 0.8, action)

        match = re.search(r"\bi(?:'m| am) working on (.+)", lower, flags=re.IGNORECASE)
        if match:
            project = _clean_group(match.group(1))
            add("project", f"Working on {project}", 0.92, 0.72, project)

        match = re.search(r"\bi have an idea to (.+)", lower, flags=re.IGNORECASE)
        if match:
            idea = _clean_group(match.group(1))
            add("idea", f"Idea: {idea}", 0.9, 0.58, idea)

        match = re.search(r"\bi usually (.+)", lower, flags=re.IGNORECASE)
        if match:
            routine = _clean_group(match.group(1))
            add("routine", f"Usually {routine}", 0.88, 0.5, routine)

        return candidates


def _sentences(text: str) -> list[str]:
    clean = " ".join(text.strip().split())
    if not clean:
        return []
    return [part.strip() for part in re.split(r"(?<=[.!?])\s+|\n+", clean) if part.strip()]


def _clean_group(value: str) -> str:
    return value.strip(" .!?\"'")


def _clean_subject(value: str | None) -> str | None:
    if not value:
        return None
    value = _canonical(value)
    return value or None


def _canonical(value: str) -> str:
    return " ".join(re.findall(r"[a-z0-9]+", value.lower()))
