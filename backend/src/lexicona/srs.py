"""Deterministic internal review schedule, independent of visible progress."""

from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Literal

Grade = Literal["again", "hard", "good", "easy"]

_INTERVALS = {
    1: timedelta(days=1),
    2: timedelta(days=3),
    3: timedelta(days=7),
    4: timedelta(days=14),
    5: timedelta(days=30),
    6: timedelta(days=60),
}


@dataclass(frozen=True, slots=True)
class ReviewTransition:
    stage: int
    due_at: datetime
    success_streak: int
    is_lapse: bool


def review(stage: int, success_streak: int, grade: Grade, now: datetime) -> ReviewTransition:
    """Return the schedule after one graded answer at the supplied naive UTC time."""
    if grade == "again":
        return ReviewTransition(0, now + timedelta(minutes=10), 0, True)
    if grade == "hard":
        return ReviewTransition(stage, now + timedelta(days=1), 0, False)
    next_stage = min(6, stage + (2 if grade == "easy" else 1))
    return ReviewTransition(next_stage, now + _INTERVALS[next_stage], success_streak + 1, False)
