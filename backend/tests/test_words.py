from fastapi import FastAPI
from sqlalchemy import update

from lexicona.db import Database
from lexicona.models import Word
from tests.conftest import Client, add_word


async def set_progress(app: FastAPI, word_id: str, value: int) -> None:
    database: Database = app.state.db
    async with database.sessions() as db:
        await db.execute(update(Word).where(Word.id == word_id).values(progress=value))
        await db.commit()


async def test_create_and_list(alice: Client) -> None:
    word = await add_word(alice, "  cat ", "кот", "кошка", transcription="kæt", note="")
    assert word["headword"] == "cat"
    assert word["translations"] == ["кот", "кошка"]
    assert word["transcription"] == "kæt"
    assert word["note"] is None
    assert word["progress"] == 0
    listed = (await alice.get("/api/words")).json()
    assert [w["id"] for w in listed] == [word["id"]]


async def test_validation(alice: Client) -> None:
    for payload in [
        {"headword": "", "translations": ["x"]},
        {"headword": "cat", "translations": []},
        {"headword": "cat", "translations": ["кот", " Кот "]},
        {"headword": "cat", "translations": ["x"] * 11},
        {"headword": "x" * 201, "translations": ["x"]},
        {"headword": "cat", "translations": ["кот"], "note": "x" * 4001},
    ]:
        assert (await alice.post("/api/words", json=payload)).status_code == 422, payload


async def test_search_by_headword_or_translation(alice: Client) -> None:
    await add_word(alice, "cat", "кот")
    await add_word(alice, "dog", "собака")
    await add_word(alice, "100%_sure", "уверен")

    async def search(q: str) -> list[str]:
        return [w["headword"] for w in (await alice.get("/api/words", params={"q": q})).json()]

    assert await search("CA") == ["cat"]
    assert await search("соб") == ["dog"]
    assert await search("%") == ["100%_sure"]
    assert await search("_") == ["100%_sure"]


async def test_cosmetic_edit_keeps_progress(app: FastAPI, alice: Client) -> None:
    word = await add_word(alice, "cat", "кот")
    await set_progress(app, word["id"], 40)
    response = await alice.put(
        f"/api/words/{word['id']}",
        json={"headword": "Cat", "translations": ["Кот"], "note": "pet"},
    )
    assert response.json()["progress"] == 40
    assert response.json()["note"] == "pet"


async def test_meaning_edit_resets_progress(app: FastAPI, alice: Client) -> None:
    word = await add_word(alice, "cat", "кот", "кошка")
    await set_progress(app, word["id"], 40)
    response = await alice.put(
        f"/api/words/{word['id']}", json={"headword": "cat", "translations": ["кошка"]}
    )
    assert response.json()["translations"] == ["кошка"]
    assert response.json()["progress"] == 0


async def test_translations_can_be_reordered_and_extended(alice: Client) -> None:
    word = await add_word(alice, "cat", "кот", "кошка")
    response = await alice.put(
        f"/api/words/{word['id']}",
        json={"headword": "cat", "translations": ["кошка", "кот", "котик"]},
    )
    assert response.status_code == 200
    assert response.json()["translations"] == ["кошка", "кот", "котик"]


async def test_delete(alice: Client) -> None:
    word = await add_word(alice, "cat", "кот")
    assert (await alice.delete(f"/api/words/{word['id']}")).status_code == 204
    assert (await alice.get(f"/api/words/{word['id']}")).status_code == 404


async def test_other_users_words_are_invisible(alice: Client, bob: Client) -> None:
    word = await add_word(alice, "cat", "кот")
    url = f"/api/words/{word['id']}"
    assert (await bob.get("/api/words")).json() == []
    assert (await bob.get(url)).status_code == 404
    put = await bob.put(url, json={"headword": "x", "translations": ["y"]})
    assert put.status_code == 404
    assert (await bob.delete(url)).status_code == 404
    assert (await alice.get(url)).json()["headword"] == "cat"
