"""Registration uses the existing native owner through cancellation and commit."""

import asyncio
import sqlite3
from contextlib import closing
from time import monotonic

import pytest
from invite_helpers import REGISTER, Registration, registration, signed_in
from test_auth_native_lifecycle import NativeBarrier

from lexicona.auth import boundary
from lexicona.auth.errors import Decision

__all__ = ["registration", "signed_in"]


@pytest.mark.parametrize(
    "phase",
    [
        "prewrite",
        "queued_begin",
        "begin",
        "queued_write",
        "insert",
        "queued_commit",
        "commit",
        "after_commit",
    ],
)
@pytest.mark.parametrize("cancel", [True, False], ids=["cancel", "deadline"])
async def test_register_native_finalization_matrix(
    registration: Registration,
    monkeypatch: pytest.MonkeyPatch,
    phase: str,
    cancel: bool,
) -> None:
    r = registration
    deadlines: list[float] = []

    def admit(deadline: float) -> Decision:
        value = Decision(monotonic() + (12 if cancel else 0.6))
        deadlines.append(value.deadline)
        return value

    monkeypatch.setattr(boundary, "Decision", admit)
    barrier = NativeBarrier(phase)
    barrier.install(monkeypatch)
    task = asyncio.create_task(r.client.post(REGISTER, json=r.data, headers=r.headers))
    try:
        await asyncio.wait_for(barrier.entered.wait(), 4)
        submitted = list(barrier.submissions)
        if cancel:
            for _ in range(3):
                task.cancel()
                await asyncio.sleep(0)
        # An actual submitted native callable is still outstanding. Expiry is
        # admission, not permission to leave that callable in a reusable pool.
        await asyncio.wait([task], timeout=0.08 if cancel else 0.7)
        assert not task.done() and not barrier.finished
        barrier.release.set()
        if cancel:
            with pytest.raises(asyncio.CancelledError):
                await task
        else:
            response = await task
            assert response.status_code in {408, 503}
            assert "set-cookie" not in response.headers
        assert barrier.finished and barrier.submissions == submitted
        committed = phase in {"queued_commit", "commit", "after_commit"}
        assert barrier.target is not None
        if barrier.target._connection is None:
            await asyncio.to_thread(barrier.target._thread.join, 3)
            assert not barrier.target._thread.is_alive()
        with closing(sqlite3.connect(r.account.path)) as db:
            assert db.execute(
                "SELECT count(*) FROM users WHERE role='user'"
            ).fetchone() == (int(committed),)
            assert db.execute("SELECT count(*) FROM user_settings").fetchone() == (
                1 + int(committed),
            )
            assert db.execute(
                "SELECT count(*) FROM invites WHERE used_at IS NOT NULL"
            ).fetchone() == (int(committed),)
            assert db.execute(
                "SELECT count(*) FROM auth_sessions WHERE user_id IS NOT NULL"
            ).fetchone() == (1 + int(committed),)
            assert db.execute("PRAGMA foreign_key_check").fetchall() == []
        print(
            {
                "phase": phase,
                "cancel": cancel,
                "known_committed": committed,
                "finalization_overshoot_ms": 0
                if cancel
                else round(max(0, monotonic() - deadlines[0]) * 1000, 1),
            }
        )
    finally:
        barrier.release.set()
        await asyncio.gather(task, *barrier.heads, return_exceptions=True)


async def test_register_lost_commit_is_not_rollback_or_retried(
    registration: Registration, monkeypatch: pytest.MonkeyPatch
) -> None:
    r = registration
    barrier = NativeBarrier("lost_commit")
    barrier.install(monkeypatch)
    response = await r.client.post(REGISTER, json=r.data, headers=r.headers)
    assert (
        response.status_code == 503
        and response.json()["error"]["code"] == "service_unavailable"
    )
    assert "set-cookie" not in response.headers
    assert barrier.submissions.count("commit") == 1
    assert barrier.target is not None and barrier.target._connection is None
    await asyncio.to_thread(barrier.target._thread.join, 3)
    assert not barrier.target._thread.is_alive()
    with closing(sqlite3.connect(r.account.path)) as db:
        assert db.execute(
            "SELECT count(*) FROM users WHERE role='user'"
        ).fetchone() == (1,)
        assert db.execute(
            "SELECT count(*) FROM invites WHERE used_at IS NOT NULL"
        ).fetchone() == (1,)


@pytest.mark.parametrize("operation", ["create", "revoke"])
async def test_admin_lost_commit_has_no_secret_response_or_blind_retry(
    registration: Registration, monkeypatch: pytest.MonkeyPatch, operation: str
) -> None:
    from invite_helpers import CREATE, admin_headers

    r = registration
    barrier = NativeBarrier("lost_commit")
    barrier.install(monkeypatch)
    route = CREATE if operation == "create" else CREATE + "/" + r.id + "/revoke"
    response = await r.account.client.post(
        route,
        json={} if operation == "create" else {"expected_version": 1},
        headers=admin_headers(r.account),
    )
    assert response.status_code == 503 and "set-cookie" not in response.headers
    assert response.json()["error"]["code"] == "service_unavailable"
    assert barrier.submissions.count("commit") == 1
    assert barrier.target is not None and barrier.target._connection is None
    await asyncio.to_thread(barrier.target._thread.join, 3)
    assert not barrier.target._thread.is_alive()
    with closing(sqlite3.connect(r.account.path)) as db:
        assert db.execute("SELECT count(*) FROM invites").fetchone() == (
            (2 if operation == "create" else 1),
        )
        assert db.execute(
            "SELECT count(*) FROM invites WHERE revoked_at IS NOT NULL"
        ).fetchone() == (int(operation == "revoke"),)
    listed = await r.account.client.get(CREATE)
    assert listed.status_code == 200
    assert "invite_token" not in listed.text and "token_hash" not in listed.text
