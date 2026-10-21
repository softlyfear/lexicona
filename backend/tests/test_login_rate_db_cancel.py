"""A verified credential is not success when the final native UoW is cancelled."""

import asyncio
import sqlite3
from contextlib import closing

import pytest
from test_auth_native_lifecycle import NativeBarrier
from test_login_rates_http import LOGIN, pre_auth
from test_login_rates_resources import Harness, harness

__all__ = ["harness"]


async def test_verified_password_then_db_cancel_is_not_success(
    harness: Harness,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async with harness.client() as client:
        headers = await pre_auth(client)
        for _ in range(4):
            response = await client.post(
                LOGIN,
                headers=headers,
                json={
                    "login": "admin",
                    "password": "synthetic-wrong",
                },
            )
            assert response.status_code == 401
        native = NativeBarrier("insert")
        native.install(monkeypatch)
        task = asyncio.create_task(
            client.post(
                LOGIN,
                headers=headers,
                json={
                    "login": "admin",
                    "password": harness.password,
                },
            )
        )
        try:
            await asyncio.wait_for(native.entered.wait(), 3)
            assert harness.hasher.calls == 5
            task.cancel()
            await asyncio.sleep(0.02)
            assert not task.done()
            native.release.set()
            with pytest.raises(asyncio.CancelledError):
                await task
            assert native.finished
            response = await client.post(
                LOGIN,
                headers=headers,
                json={
                    "login": "admin",
                    "password": harness.password,
                },
            )
            assert response.status_code == 429 and harness.hasher.calls == 5
            with closing(sqlite3.connect(harness.path)) as connection:
                assert connection.execute(
                    "SELECT count(*) FROM auth_sessions WHERE user_id IS NOT NULL"
                ).fetchone() == (0,)
        finally:
            native.release.set()
            await asyncio.gather(task, return_exceptions=True)
