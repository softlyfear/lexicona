from datetime import timedelta
from typing import Any, Literal

from fastapi import APIRouter
from sqlalchemy import select

from lexicona.infrastructure.db import utcnow
from lexicona.infrastructure.models import AnswerEvent, Word
from lexicona.interfaces.http.deps import CurrentAuth, Db

router = APIRouter(tags=["statistics"])


@router.get("/statistics")
async def statistics(
    auth: CurrentAuth, db: Db, period: Literal["30d", "year", "all"] = "30d"
) -> dict[str, Any]:
    today = (utcnow() + timedelta(hours=3)).date()
    started = (auth.user.statistics_started_at + timedelta(hours=3)).date()
    words = list(await db.scalars(select(Word).where(Word.owner_id == auth.user.id)))
    events = list(await db.scalars(select(AnswerEvent).where(AnswerEvent.owner_id == auth.user.id)))
    daily: dict[str, list[int]] = {}
    for event in events:
        key = (event.created_at + timedelta(hours=3)).date().isoformat()
        counts = daily.setdefault(key, [0, 0])
        counts[0] += 1
        counts[1] += int(event.correct)
    start = started if period == "all" else today - timedelta(days=29 if period == "30d" else 364)
    days = []
    day = start
    while day <= today:
        key = day.isoformat()
        counts = daily.get(key, [0, 0])
        days.append({"date": key, "answers": counts[0], "correct": counts[1]})
        day += timedelta(days=1)
    total = len(events)
    correct = sum(int(event.correct) for event in events)
    learned = sum(word.progress >= 100 for word in words)
    return {
        "period": period,
        "history_started_at": auth.user.statistics_started_at,
        "total_words": len(words),
        "learned_words": learned,
        "unlearned_words": len(words) - learned,
        "total_answers": total,
        "correct_answers": correct,
        "accuracy_percent": round(correct * 100 / total, 1) if total else 0,
        "average_answers_per_day": round(total / max(1, (today - started).days + 1), 2),
        "active_days": len(daily),
        "days": days,
    }
