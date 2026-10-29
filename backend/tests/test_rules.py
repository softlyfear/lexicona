import pytest

from lexicona.normalize import normalize
from lexicona.progress import AnswerKind, Difficulty, apply, delta

D = Difficulty


@pytest.mark.parametrize(
    ("difficulty", "expected"),
    [
        (D.VERY_EASY, (10, -10, 20, -10, 5)),
        (D.EASY, (7, -7, 14, -7, 3)),
        (D.MEDIUM, (4, -4, 8, -4, 2)),
        (D.HARD, (3, -3, 6, -3, 1)),
        (D.VERY_HARD, (2, -2, 4, -2, 1)),
    ],
)
def test_delta_table(difficulty: Difficulty, expected: tuple[int, ...]) -> None:
    assert (
        delta(difficulty, AnswerKind.CHOICE, True),
        delta(difficulty, AnswerKind.CHOICE, False),
        delta(difficulty, AnswerKind.TYPED, True),
        delta(difficulty, AnswerKind.TYPED, False),
        delta(difficulty, AnswerKind.PASSIVE, True),
    ) == expected


def test_interrupted_passive_listening_is_not_a_penalty() -> None:
    assert delta(D.VERY_EASY, AnswerKind.PASSIVE, False) == 0


@pytest.mark.parametrize(
    ("before", "change", "after"),
    [(0, -10, 0), (3, -4, 0), (50, 8, 58), (96, 10, 100), (100, 20, 100), (100, -2, 98)],
)
def test_apply_clamps_to_range(before: int, change: int, after: int) -> None:
    assert apply(before, change) == after


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("  Hello   World ", "hello world"),
        ("Don’t", "don't"),
        ("Ёлка", "елка"),
        ("Run.", "run"),
        ("Wait...", "wait..."),
        ("STRASSE", "strasse"),
        ("é", "é"),
    ],
)
def test_normalize(raw: str, expected: str) -> None:
    assert normalize(raw) == expected


def test_normalize_keeps_negation() -> None:
    assert normalize("can't") != normalize("can")
