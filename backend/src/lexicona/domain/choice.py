from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class ChoiceEntry:
    entry_id: int
    headword: str
    normalized_headword: str
    translations: tuple[tuple[str, str], ...]
