import asyncio

from fastapi import FastAPI
from sqlalchemy import update

from lexicona.infrastructure.db import Database
from lexicona.infrastructure.models import Word, WordTranslation
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
        {"headword": ".", "translations": ["кот"]},
        {"headword": " . ", "translations": ["кот"]},
        {"headword": "cat", "translations": ["."]},
        {"headword": "cat", "translations": [" . "]},
        {"headword": "cat", "translations": ["кот", "кот."]},
        {"headword": "cat", "translations": ["кот дома", "кот  дома"]},
        {"headword": "cat", "translations": ["Don’t", "don't"]},
    ]:
        assert (await alice.post("/api/words", json=payload)).status_code == 422, payload
    ellipsis = await alice.post(
        "/api/words", json={"headword": "...", "translations": ["многоточие"]}
    )
    assert ellipsis.status_code == 201


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


async def test_translations_can_be_reordered_and_extended(app: FastAPI, alice: Client) -> None:
    word = await add_word(alice, "cat", "кот", "кошка")
    await set_progress(app, word["id"], 40)
    response = await alice.put(
        f"/api/words/{word['id']}",
        json={"headword": "cat", "translations": ["кошка", "кот", "котик"]},
    )
    assert response.status_code == 200
    assert response.json()["translations"] == ["кошка", "кот", "котик"]
    assert response.json()["progress"] == 0


async def test_reordering_the_same_translations_keeps_progress(app: FastAPI, alice: Client) -> None:
    word = await add_word(alice, "cat", "кот", "кошка")
    await set_progress(app, word["id"], 40)
    reordered = await alice.put(
        f"/api/words/{word['id']}",
        json={"headword": "cat", "translations": ["кошка", "кот"]},
    )
    assert reordered.status_code == 200
    assert reordered.json()["translations"] == ["кошка", "кот"]
    assert reordered.json()["progress"] == 40
    cosmetic = await alice.put(
        f"/api/words/{word['id']}",
        json={"headword": "cat", "translations": ["Кот.", "КОШКА"]},
    )
    assert cosmetic.status_code == 200
    assert cosmetic.json()["translations"] == ["Кот.", "КОШКА"]
    assert cosmetic.json()["progress"] == 40
    database: Database = app.state.db
    async with database.sessions() as db:
        saved = await db.get(Word, word["id"])
        assert saved is not None and saved.content_version == 1


async def test_delete(alice: Client) -> None:
    word = await add_word(alice, "cat", "кот")
    assert (await alice.delete(f"/api/words/{word['id']}")).status_code == 204
    assert (await alice.get(f"/api/words/{word['id']}")).status_code == 404


async def test_duplicate_headword_is_rejected(alice: Client, bob: Client) -> None:
    await add_word(alice, "until", "до тех пор")
    for headword in ("until", "Until", " until ", "until."):
        response = await alice.post(
            "/api/words", json={"headword": headword, "translations": ["другой перевод"]}
        )
        assert response.status_code == 409, headword
        assert response.json()["detail"] == "word_exists"
    await add_word(alice, "ёж", "животное")
    yo = await alice.post("/api/words", json={"headword": "еж", "translations": ["зверь"]})
    assert yo.status_code == 409
    await add_word(alice, "don’t", "не")
    apostrophe = await alice.post("/api/words", json={"headword": "don't", "translations": ["нет"]})
    assert apostrophe.status_code == 409
    created = await bob.post(
        "/api/words", json={"headword": "until", "translations": ["до тех пор"]}
    )
    assert created.status_code == 201
    excluded = await add_word(alice, "sleigh", "сани")
    assert (
        await alice.patch(f"/api/words/{excluded['id']}/training", json={"is_excluded": True})
    ).status_code == 200
    learned = await add_word(alice, "validate", "проверять")
    assert (
        await alice.patch(f"/api/words/{learned['id']}/learned", json={"is_learned": True})
    ).status_code == 200
    for headword in ("Sleigh", "Validate"):
        again = await alice.post("/api/words", json={"headword": headword, "translations": ["ещё"]})
        assert again.status_code == 409
    visible = [word["headword"] for word in (await alice.get("/api/words?training=all")).json()]
    assert visible.count("until") == 1
    assert "еж" not in visible
    assert "ёж" in visible


async def test_duplicate_phrase_is_rejected_like_a_word(alice: Client) -> None:
    await add_word(alice, "fake it till you make it", "притворяйся, пока это не станет правдой")
    for headword in (
        "fake it till you make it",
        "Fake It Till You Make It",
        "  fake   it till you make it ",
        "fake it till you make it.",
        "FAKE IT TILL YOU MAKE IT.",
    ):
        response = await alice.post(
            "/api/words", json={"headword": headword, "translations": ["другой перевод"]}
        )
        assert response.status_code == 409, headword
        assert response.json()["detail"] == "word_exists"
    shorter = await add_word(alice, "fake", "подделка")
    assert shorter["headword"] == "fake"
    contained = await add_word(alice, "make it", "добьёмся")
    assert contained["headword"] == "make it"
    await add_word(alice, "don’t look back", "не оглядывайся")
    apostrophe = await alice.post(
        "/api/words", json={"headword": "don't look back", "translations": ["не смотри назад"]}
    )
    assert apostrophe.status_code == 409
    learned = await add_word(alice, "cut to the chase", "перейти к делу")
    assert (
        await alice.patch(f"/api/words/{learned['id']}/learned", json={"is_learned": True})
    ).status_code == 200
    again = await alice.post(
        "/api/words", json={"headword": "Cut to the chase.", "translations": ["к сути"]}
    )
    assert again.status_code == 409
    renamed = await alice.put(
        f"/api/words/{shorter['id']}",
        json={"headword": "fake it till you make it", "translations": ["подделка"]},
    )
    assert renamed.status_code == 409
    kept = (await alice.get(f"/api/words/{shorter['id']}")).json()
    assert kept["headword"] == "fake"
    assert kept["translations"] == ["подделка"]
    saved = [word["headword"] for word in (await alice.get("/api/words?training=all")).json()]
    assert saved.count("fake it till you make it") == 1
    assert saved.count("fake") == 1
    assert saved.count("cut to the chase") == 1


async def test_rename_onto_existing_headword_is_rejected(app: FastAPI, alice: Client) -> None:
    original = await add_word(alice, "until", "до")
    other = await add_word(alice, "till", "пока")
    await set_progress(app, other["id"], 15)
    response = await alice.put(
        f"/api/words/{other['id']}",
        json={"headword": "Until.", "translations": ["до тех пор"]},
    )
    assert response.status_code == 409
    assert response.json()["detail"] == "word_exists"
    kept = (await alice.get(f"/api/words/{other['id']}")).json()
    assert kept["headword"] == "till"
    assert kept["translations"] == ["пока"]
    assert kept["progress"] == 15
    same = await alice.put(
        f"/api/words/{original['id']}",
        json={"headword": "UNTIL", "translations": ["до тех пор, пока не"]},
    )
    assert same.status_code == 200
    assert same.json()["headword"] == "UNTIL"
    assert same.json()["progress"] == 0


async def test_existing_duplicate_stays_editable(app: FastAPI, alice: Client) -> None:
    await add_word(alice, "until", "до")
    owner_id = (await alice.get("/api/auth/me")).json()["user"]["id"]
    database: Database = app.state.db
    async with database.sessions() as db:
        extra = Word(owner_id=owner_id, headword="until", normalized_headword="until")
        extra.translations.append(WordTranslation(position=0, text="пока", normalized_text="пока"))
        db.add(extra)
        await db.commit()
        extra_id = extra.id
    edited = await alice.put(
        f"/api/words/{extra_id}", json={"headword": "until", "translations": ["пока не"]}
    )
    assert edited.status_code == 200
    assert edited.json()["translations"] == ["пока не"]
    blocked = await alice.post(
        "/api/words", json={"headword": "until", "translations": ["ещё одно"]}
    )
    assert blocked.status_code == 409


async def test_duplicate_create_waits_for_the_open_write(app: FastAPI, alice: Client) -> None:
    owner_id = (await alice.get("/api/auth/me")).json()["user"]["id"]
    database: Database = app.state.db
    async with database.sessions() as holder:
        pending = Word(owner_id=owner_id, headword="until", normalized_headword="until")
        pending.translations.append(WordTranslation(position=0, text="до", normalized_text="до"))
        holder.add(pending)
        await holder.flush()
        task = asyncio.create_task(
            alice.post("/api/words", json={"headword": "Until.", "translations": ["пока"]})
        )
        # A reader still proceeds and must not observe the uncommitted row.
        # The create stays blocked on the reserved lock instead of inserting a second copy.
        visible = await asyncio.wait_for(alice.get("/api/words?training=all"), timeout=2)
        assert visible.status_code == 200
        assert [word["headword"] for word in visible.json()].count("until") == 0
        await asyncio.sleep(0.4)
        blocked = not task.done()
        await holder.commit()
    response = await asyncio.wait_for(task, timeout=3)
    assert blocked, response.text
    assert response.status_code == 409
    assert response.json()["detail"] == "word_exists"
    saved = [word["headword"] for word in (await alice.get("/api/words?training=all")).json()]
    assert saved.count("until") == 1


async def test_rename_waits_for_the_open_write(app: FastAPI, alice: Client) -> None:
    original = await add_word(alice, "till", "пока")
    owner_id = (await alice.get("/api/auth/me")).json()["user"]["id"]
    database: Database = app.state.db
    async with database.sessions() as holder:
        pending = Word(owner_id=owner_id, headword="until", normalized_headword="until")
        pending.translations.append(WordTranslation(position=0, text="до", normalized_text="до"))
        holder.add(pending)
        await holder.flush()
        task = asyncio.create_task(
            alice.put(
                f"/api/words/{original['id']}",
                json={"headword": "until", "translations": ["пока"]},
            )
        )
        await asyncio.sleep(0.4)
        blocked = not task.done()
        await holder.commit()
    response = await asyncio.wait_for(task, timeout=3)
    assert blocked, response.text
    assert response.status_code == 409
    assert response.json()["detail"] == "word_exists"
    kept = (await alice.get(f"/api/words/{original['id']}")).json()
    assert kept["headword"] == "till"
    assert kept["translations"] == ["пока"]


async def test_other_users_words_are_invisible(alice: Client, bob: Client) -> None:
    word = await add_word(alice, "cat", "кот")
    url = f"/api/words/{word['id']}"
    assert (await bob.get("/api/words")).json() == []
    assert (await bob.get(url)).status_code == 404
    put = await bob.put(url, json={"headword": "x", "translations": ["y"]})
    assert put.status_code == 404
    assert (await bob.delete(url)).status_code == 404
    assert (await alice.get(url)).json()["headword"] == "cat"
