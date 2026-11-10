import asyncio
from typing import Any

from fastapi import FastAPI
from sqlalchemy import select

from lexicona.infrastructure.db import Database
from lexicona.infrastructure.models import Tag, Word
from tests.conftest import Client, add_word
from tests.test_training import correct_option, seed, start
from tests.test_words import set_progress


async def test_tags_roundtrip_and_validation(alice: Client) -> None:
    word = await add_word(alice, "one", "один", tags=["  Работа \t дома  ", "Ё", "е", "x-y"])
    assert [t["name"] for t in word["tags"]] == ["е", "Ё", "Работа дома", "x-y"] or {
        t["name"] for t in word["tags"]
    } == {"Работа дома", "Ё", "е", "x-y"}
    other = await add_word(alice, "two", "два", tags=["работа дома"])
    assert other["tags"][0] == next(t for t in word["tags"] if t["name"] == "Работа дома")
    body = {"headword": "one", "translations": ["один"]}
    response = await alice.put(f"/api/words/{word['id']}", json=body)
    assert response.json()["tags"] == word["tags"]
    response = await alice.put(f"/api/words/{word['id']}", json={**body, "tags": []})
    assert response.json()["tags"] == []
    assert len((await alice.get("/api/tags")).json()) == 4
    for invalid in (["A", " a "], [""], ["a" * 81], list(map(str, range(21))), [1], None):
        assert (await alice.post("/api/words", json={**body, "tags": invalid})).status_code == 422
    created = await alice.post("/api/words", json={**body, "headword": "three", "tags": ["a" * 80]})
    assert created.status_code == 201


async def test_owner_filter_csrf_and_cascade(alice: Client, bob: Client, anon: Client) -> None:
    assert (await anon.get("/api/tags")).status_code == 401
    a = await add_word(alice, "apple", "яблоко", tags=["fruit", "food"])
    b = await add_word(alice, "apricot", "абрикос", tags=["fruit"])
    c = await add_word(alice, "bread", "хлеб", tags=["food"])
    foreign = await add_word(bob, "secret", "секрет", tags=["private"])
    tags = {t["name"]: t["id"] for t in a["tags"]}
    tag_list = await alice.get("/api/tags")
    assert tag_list.headers["cache-control"] == "no-store"
    assert {t["id"] for t in tag_list.json()} == set(tags.values())
    both = await alice.get(
        "/api/words", params=[("tag_id", tags["fruit"]), ("tag_id", tags["food"])]
    )
    assert {w["id"] for w in both.json()} == {a["id"], b["id"], c["id"]}
    assert len(both.json()) == 3
    await alice.patch(f"/api/words/{c['id']}/training", json={"is_excluded": True})
    active = await alice.get(
        "/api/words",
        params=[
            ("tag_id", tags["fruit"]),
            ("tag_id", tags["food"]),
            ("q", "a"),
            ("sort", "headword_asc"),
        ],
    )
    assert [w["id"] for w in active.json()] == [a["id"], b["id"]]
    response = await alice.get(
        "/api/words",
        params=[
            ("tag_id", tags["fruit"]),
            ("tag_id", tags["food"]),
            ("tag_id", tags["fruit"]),
            ("q", "app"),
            ("training", "all"),
            ("sort", "headword_asc"),
        ],
    )
    assert [w["id"] for w in response.json()] == [a["id"]]
    assert response.headers["cache-control"] == "no-store"
    for tag_id in (foreign["tags"][0]["id"], "missing"):
        response = await alice.get("/api/words", params={"tag_id": tag_id})
        assert response.status_code == 404 and response.json()["detail"] == "tag_not_found"
    assert (await alice.get(f"/api/words/{foreign['id']}")).status_code == 404
    assert (
        await alice.put(
            f"/api/words/{foreign['id']}", json={"headword": "x", "translations": ["y"], "tags": []}
        )
    ).status_code == 404
    alice.headers.pop("X-CSRF-Token")
    assert (
        await alice.post(
            "/api/words", json={"headword": "blocked", "translations": ["нет"], "tags": ["new"]}
        )
    ).status_code == 403
    assert (
        await alice.put(
            f"/api/words/{a['id']}",
            json={"headword": "apple", "translations": ["яблоко"], "tags": []},
        )
    ).status_code == 403
    alice.headers["X-CSRF-Token"] = alice.csrf
    assert (await alice.delete(f"/api/words/{a['id']}")).status_code == 204
    assert (await alice.get(f"/api/words/{b['id']}")).json()["tags"][0]["name"] == "fruit"


async def test_concurrent_create_and_cosmetic_state(alice: Client, app: FastAPI) -> None:
    first, second = await asyncio.gather(
        alice.post(
            "/api/words", json={"headword": "one", "translations": ["один"], "tags": [" NEW "]}
        ),
        alice.post(
            "/api/words", json={"headword": "two", "translations": ["два"], "tags": ["new"]}
        ),
    )
    assert first.status_code == second.status_code == 201
    assert first.json()["tags"] == second.json()["tags"]
    database: Database = app.state.db
    async with database.sessions() as db:
        word = await db.scalar(select(Word).where(Word.id == first.json()["id"]))
        assert word is not None
        word.progress = 123
        word.is_excluded = True
        word.training_version = 7
        word.content_version = 8
        await db.commit()
    response = await alice.put(
        f"/api/words/{word.id}",
        json={"headword": "one", "translations": ["один"], "tags": ["changed"]},
    )
    assert response.status_code == 200 and response.json()["progress"] == 123
    async with database.sessions() as db:
        saved = await db.get(Word, word.id)
        assert saved is not None
        assert (
            saved.progress,
            saved.is_excluded,
            saved.training_version,
            saved.content_version,
        ) == (123, True, 7, 8)
        assert len((await db.scalars(select(Tag).where(Tag.normalized_name == "new"))).all()) == 1


async def test_cross_owner_database_constraint(alice: Client, bob: Client, app: FastAPI) -> None:
    import pytest
    from sqlalchemy.exc import IntegrityError

    from lexicona.infrastructure.models import WordTag

    word = await add_word(alice, "word", "слово")
    tag = (await add_word(bob, "other", "другой", tags=["private"]))["tags"][0]
    database: Database = app.state.db
    async with database.sessions() as db:
        owner = await db.scalar(select(Word.owner_id).where(Word.id == word["id"]))
        db.add(WordTag(owner_id=owner, word_id=word["id"], tag_id=tag["id"]))
        with pytest.raises(IntegrityError):
            await db.commit()


async def test_unicode_names_and_filter_boundaries(alice: Client, bob: Client) -> None:
    original = await add_word(alice, "one", "один", tags=["  E\u0301\u0085Straße  "])
    same = await add_word(alice, "two", "два", tags=["é STRASSE"])
    assert original["tags"] == same["tags"]
    assert original["tags"][0]["name"] == "É Straße"
    foreign = await add_word(bob, "other", "другой", tags=["é strasse"])
    assert foreign["tags"][0]["id"] != original["tags"][0]["id"]
    assert (await alice.get("/api/tags")).json() == original["tags"]
    distinct = await add_word(
        alice, "three", "три", tags=["ёлка", "елка", "a-b", "ab", "a'b", "a’b"]
    )
    assert len({tag["id"] for tag in distinct["tags"]}) == 6
    body = {"headword": "invalid", "translations": ["ошибка"]}
    invalid_names: list[list[Any]] = [
        ["É", "e\u0301"],
        ["Straße", "STRASSE"],
        ["\u0085\u2003"],
        [True],
        [{}],
    ]
    for names in invalid_names:
        assert (await alice.post("/api/words", json={**body, "tags": names})).status_code == 422
    twenty = [f"tag{i}" for i in range(20)]
    assert (await alice.post("/api/words", json={**body, "tags": twenty})).status_code == 201
    for ids in ([""], ["x" * 33], ["missing"] * 21):
        assert (
            await alice.get("/api/words", params=[("tag_id", i) for i in ids])
        ).status_code == 422


async def test_tag_edit_keeps_open_item_and_counts_answer_once(alice: Client, app: FastAPI) -> None:
    words = await seed(alice)
    await set_progress(app, words["cat"]["id"], 123)
    item = next(i for i in (await start(alice))["items"] if i["prompt"] == "cat")
    response = await alice.put(
        f"/api/words/{words['cat']['id']}",
        json={"headword": "cat", "translations": ["кот"], "tags": ["животные"]},
    )
    assert response.status_code == 200
    assert response.json()["progress"] == 123
    right = await correct_option(app, item["id"])
    url = f"/api/training/items/{item['id']}/answer"
    first = await alice.post(url, json={"option": right})
    again = await alice.post(url, json={"option": (right + 1) % 4})
    assert first.status_code == again.status_code == 200
    assert first.json() == again.json()
    assert first.json()["delta"] == 4
    assert first.json()["progress"] == 127
    assert (await alice.get(f"/api/words/{words['cat']['id']}")).json()["progress"] == 127
