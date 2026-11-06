from enum import StrEnum

MIN_PROGRESS = 0


class Difficulty(StrEnum):
    VERY_EASY = "very_easy"
    EASY = "easy"
    MEDIUM = "medium"
    HARD = "hard"
    VERY_HARD = "very_hard"


class AnswerKind(StrEnum):
    CHOICE = "choice"
    TYPED = "typed"
    PASSIVE = "passive"


# (choice correct, choice wrong, typed correct, typed wrong, passive)
_DELTAS: dict[Difficulty, tuple[int, int, int, int, int]] = {
    Difficulty.VERY_EASY: (10, -10, 20, -10, 5),
    Difficulty.EASY: (7, -7, 14, -7, 3),
    Difficulty.MEDIUM: (4, -4, 8, -4, 2),
    Difficulty.HARD: (3, -3, 6, -3, 1),
    Difficulty.VERY_HARD: (2, -2, 4, -2, 1),
}


def delta(
    difficulty: Difficulty, kind: AnswerKind, correct: bool, *, matching: bool = False
) -> int:
    choice_ok, choice_bad, typed_ok, typed_bad, passive = _DELTAS[difficulty]
    match kind:
        case AnswerKind.CHOICE:
            # A matching pair is a recognition tap. A correct one is worth half a
            # choice answer, rounded down, and still at least one point.
            if matching and correct:
                return max(1, choice_ok // 2)
            return choice_ok if correct else choice_bad
        case AnswerKind.TYPED:
            return typed_ok if correct else typed_bad
        case AnswerKind.PASSIVE:
            # Passive listening has no wrong answer; an interrupted one just doesn't count.
            return passive if correct else 0


def apply(progress: int, change: int) -> int:
    return max(MIN_PROGRESS, progress + change)
