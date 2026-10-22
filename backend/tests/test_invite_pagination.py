"""Strict query parsing and stable keyset pagination over actual invite rows."""

import base64
import json
import sqlite3
from contextlib import closing
from uuid import uuid4

import pytest
from test_auth_http import SignedIn
from test_auth_http import signed_in as signed_in


async def test_keyset_ties_insert_between_pages_and_strict_query(
    signed_in: SignedIn,
) -> None:
    account = signed_in
    headers = {
        "X-CSRF-Token": account.auth.json()["csrf_token"],
        "X-Lexicona-Expected-Principal": "user:" + account.auth.json()["user"]["id"],
    }
    ids = []
    for _ in range(6):
        response = await account.client.post(
            "/api/v1/admin/invites", json={}, headers=headers
        )
        assert response.status_code == 201
        ids.append(response.json()["invite"]["id"])
    first = await account.client.get("/api/v1/admin/invites?limit=2")
    assert first.status_code == 200
    data = first.json()
    assert [row["id"] for row in data["items"]] == sorted(ids, reverse=True)[:2]
    cursor = data["next_cursor"]
    assert isinstance(cursor, str) and len(cursor) <= 256
    position = json.loads(base64.urlsafe_b64decode(cursor + "=" * (-len(cursor) % 4)))
    assert set(position) == {"v", "created_at_us", "id"} and position["v"] == 1
    # A concurrent newer row cannot duplicate the rows already delivered.
    with closing(sqlite3.connect(account.path)) as db:
        db.execute(
            "INSERT INTO invites SELECT ?,?,created_by,created_at+1,expires_at+1,"
            "NULL,NULL,NULL,1 FROM invites LIMIT 1",
            (str(uuid4()), bytes(32)),
        )
        db.commit()
    seen = [row["id"] for row in data["items"]]
    while cursor is not None:
        response = await account.client.get(
            "/api/v1/admin/invites", params={"limit": "2", "cursor": cursor}
        )
        assert response.status_code == 200
        data = response.json()
        seen.extend(row["id"] for row in data["items"])
        cursor = data["next_cursor"]
    assert seen == sorted(ids, reverse=True) and len(set(seen)) == 6
    for query, field in [
        ("limit=0", "limit"),
        ("limit=01", "limit"),
        ("limit=101", "limit"),
        ("limit=+1", "limit"),
        ("limit=-1", "limit"),
        ("limit=1.0", "limit"),
        ("limit=1&limit=2", "limit"),
        ("cursor=x&cursor=y", "cursor"),
        ("cursor=", "cursor"),
        ("extra=private", "_request"),
    ]:
        response = await account.client.get("/api/v1/admin/invites?" + query)
        assert response.status_code == 422
        assert set(response.json()["error"]["fields"]) == {field}
        assert "set-cookie" not in response.headers


@pytest.mark.parametrize(
    "kind",
    [
        "too-long",
        "padding",
        "alphabet",
        "invalid-json",
        "array",
        "extra",
        "missing",
        "version-bool",
        "version2",
        "created-bool",
        "created-negative",
        "created-overflow",
        "id-number",
        "id-v1",
        "id-upper",
        "id-compact",
        "whitespace",
        "duplicate",
        "utf8",
        "truncated",
    ],
)
def test_cursor_strict_canonical_rejection(kind: str) -> None:
    from uuid import uuid1

    from lexicona.auth.errors import AuthError
    from lexicona.auth.pagination import decode, encode

    id = str(uuid4())
    obj: dict[str, object] = {"v": 1, "created_at_us": 12, "id": id}
    if kind == "array":
        raw = b"[]"
    else:
        if kind == "extra":
            obj["x"] = 1
        elif kind == "missing":
            del obj["v"]
        elif kind == "version-bool":
            obj["v"] = True
        elif kind == "version2":
            obj["v"] = 2
        elif kind == "created-bool":
            obj["created_at_us"] = True
        elif kind == "created-negative":
            obj["created_at_us"] = -1
        elif kind == "created-overflow":
            obj["created_at_us"] = 9223372036854775808
        elif kind == "id-number":
            obj["id"] = 1
        elif kind == "id-v1":
            obj["id"] = str(uuid1())
        elif kind == "id-upper":
            obj["id"] = id.upper()
        elif kind == "id-compact":
            obj["id"] = id.replace("-", "")
        raw = json.dumps(obj, separators=(",", ":")).encode()
    if kind == "invalid-json":
        raw = b"{"
    elif kind == "whitespace":
        raw = b" " + raw
    elif kind == "duplicate":
        raw = raw.replace(b'"v":1', b'"v":1,"v":1')
    elif kind == "utf8":
        raw = b"\xff"
    value = base64.urlsafe_b64encode(raw).decode().rstrip("=")
    if kind == "too-long":
        value = "A" * 257
    elif kind == "padding":
        value += "="
    elif kind == "alphabet":
        value = "+"
    elif kind == "truncated":
        value = "A"
    with pytest.raises(AuthError) as caught:
        decode(value)
    assert caught.value.fields == {"cursor": ["Недопустимый формат."]}
    assert decode(encode(12, id)) == (12, id)
