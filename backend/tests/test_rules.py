import pytest

from lexicona.domain.normalize import hinted_text, normalize
from lexicona.domain.progress import AnswerKind, Difficulty, apply, delta, with_letter_hint

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
    assert delta(difficulty, AnswerKind.CHOICE, True, matching=True) == max(1, expected[0] // 2)
    assert delta(difficulty, AnswerKind.CHOICE, False, matching=True) == expected[1]


def test_interrupted_passive_listening_is_not_a_penalty() -> None:
    assert delta(D.VERY_EASY, AnswerKind.PASSIVE, False) == 0


def test_letter_hint_halves_only_a_positive_reward() -> None:
    assert with_letter_hint(8, True) == 4
    assert with_letter_hint(-4, True) == -4
    assert with_letter_hint(8, False) == 8
    assert with_letter_hint(0, True) == 0


@pytest.mark.parametrize(
    ("current", "answers", "shown", "complete"),
    [
        ("", ["кот", "кошка"], "к", False),
        ("к", ["кот", "кошка"], "ко", False),
        ("ко", ["кот"], "кот", True),
        ("кх", ["кот"], "ко", False),
        ("котик", ["кот"], "кот", True),
        ("КОТ.", ["кот"], "КОТ.", True),
        ("", ["agent"], "a", False),
        ("ag", ["agent"], "age", False),
        ("ко", ["кошка", "кот"], "кош", False),
        ("", ["меня", "я"], "м", False),
        ("", ["кошка", "к"], "к", False),
        ("ко", ["кот", "кошка"], "кот", True),
        ("", ["я", "меня"], "я", True),
    ],
)
def test_hinted_text_adds_one_character(
    current: str, answers: list[str], shown: str, complete: bool
) -> None:
    assert hinted_text(current, answers) == (shown, complete)
    assert shown == current or any(answer.startswith(shown) for answer in answers)


@pytest.mark.parametrize(
    ("before", "change", "after"),
    [(0, -10, 0), (3, -4, 0), (50, 8, 58), (96, 10, 106), (100, 20, 120), (100, -2, 98)],
)
def test_apply_floors_at_zero(before: int, change: int, after: int) -> None:
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
