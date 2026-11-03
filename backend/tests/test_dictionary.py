import hashlib
import io
import lzma
import tarfile
from pathlib import Path

import pytest
from fastapi import FastAPI

from lexicona import dictionary
from tests.conftest import Client, add_word
from tests.test_words import set_progress

TEI = b"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE TEI SYSTEM "freedict-P5.dtd">
<TEI xmlns="http://www.tei-c.org/ns/1.0"><teiHeader><fileDesc>credits</fileDesc></teiHeader>
<text><body><entry><form><orth>Apple</orth></form><sense>
<cit type="trans" xml:lang="ru"><quote>company</quote></cit></sense></entry>
<entry><form><orth>apple</orth><pron>/a/</pron></form><gramGrp><pos>n</pos></gramGrp><sense>
<cit type="trans" xml:lang="ru"><quote>apple translation</quote></cit></sense></entry>
</body></text></TEI>"""


def archive(tei: bytes = TEI, extra: str | None = None) -> bytes:
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode="w") as tar:
        for name, data in [("eng-rus/eng-rus.tei", tei), ("eng-rus/COPYING", b"license")]:
            info = tarfile.TarInfo(name)
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
        if extra:
            info = tarfile.TarInfo(extra)
            info.size = 1
            tar.addfile(info, io.BytesIO(b"x"))
    return lzma.compress(stream.getvalue())


def build_fixture(monkeypatch: pytest.MonkeyPatch, path: Path, data: bytes) -> None:
    monkeypatch.setattr(dictionary, "SHA256", hashlib.sha256(data).hexdigest())
    dictionary.build(data, path)


def test_build_lookup_notices_and_atomic_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "index.sqlite3"
    data = archive()
    build_fixture(monkeypatch, path, data)
    assert [x["headword"] for x in dictionary.lookup(path, "apple")["matches"]] == [
        "apple",
        "Apple",
    ]
    assert [x["headword"] for x in dictionary.lookup(path, "Apple")["matches"]] == [
        "Apple",
        "apple",
    ]
    assert dictionary.lookup(path, "apple")["matches"][0]["transcriptions"] == ["/a/"]
    assert dictionary.lookup(path, "missing")["matches"] == []
    assert dictionary.lookup(path, "apple")["spelling_suggestions"] == []
    assert dictionary.lookup(path, "appl")["spelling_suggestions"] == ["apple"]
    assert dictionary.notices(path)["copying"] == "license"
    before = path.read_bytes()
    for bad in [
        archive(extra="../escape"),
        archive(TEI.replace(b"<TEI ", b'<!ENTITY x "y"><TEI ')),
        b"broken",
    ]:
        monkeypatch.setattr(dictionary, "SHA256", hashlib.sha256(bad).hexdigest())
        with pytest.raises((ValueError, lzma.LZMAError)):
            dictionary.build(bad, path)
        assert path.read_bytes() == before


async def test_lookup_auth_csrf_and_unavailable(
    app: FastAPI,
    anon: Client,
    alice: Client,
    bob: Client,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    path = tmp_path / "index.sqlite3"
    build_fixture(monkeypatch, path, archive())
    app.state.settings.dictionary_path = path
    assert (await anon.get("/api/dictionary/notices")).status_code == 401
    alice.headers.pop("X-CSRF-Token")
    assert (
        await alice.post("/api/dictionary/lookup", json={"headword": "apple"})
    ).status_code == 403
    alice.headers["X-CSRF-Token"] = alice.csrf
    for client in [alice, bob]:
        response = await client.post("/api/dictionary/lookup", json={"headword": "apple"})
        assert response.status_code == 200
        assert response.headers["cache-control"] == "no-store"
        assert response.json()["matches"][0]["headword"] == "apple"
        assert (await client.get("/api/dictionary/notices")).json()["copying"] == "license"
    path.unlink()
    response = await alice.post("/api/dictionary/lookup", json={"headword": "apple"})
    assert response.status_code == 503 and response.json()["detail"] == "dictionary_unavailable"
    assert response.headers["cache-control"] == "no-store"
    await add_word(alice, "manual", "ручной")


async def test_refs_survival_validation_and_ownership(
    app: FastAPI, alice: Client, bob: Client
) -> None:
    ref = {"source_id": dictionary.SOURCE_ID, "entry_id": 1, "field": "translation", "value": "кот"}
    word = await add_word(alice, "cat", "кот", source_refs=[ref, ref])
    assert word["source_refs"] == [ref]
    url = f"/api/words/{word['id']}"
    assert (await bob.get(url)).status_code == 404
    assert (
        await bob.put(url, json={"headword": "cat", "translations": ["кот"], "source_refs": []})
    ).status_code == 404
    await set_progress(app, word["id"], 40)
    kept = await alice.put(url, json={"headword": "cat", "translations": ["кот"]})
    assert kept.json()["source_refs"] == [ref] and kept.json()["progress"] == 40
    changed = await alice.put(url, json={"headword": "cat", "translations": ["Кот"]})
    assert changed.json()["source_refs"] == [] and changed.json()["progress"] == 40
    invalid = await alice.put(
        url, json={"headword": "cat", "translations": ["Кот"], "source_refs": [ref]}
    )
    assert invalid.status_code == 422
    cleared = await alice.put(
        url, json={"headword": "cat", "translations": ["Кот"], "source_refs": []}
    )
    assert cleared.json()["source_refs"] == []


def test_wiki_markup_removed_from_lookup_and_choice_candidates(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "index.sqlite3"
    marked = TEI.replace(
        b"<quote>apple translation</quote>",
        b"<quote>[[simplest|simple]] [[fruit]]</quote>",
    )
    build_fixture(monkeypatch, path, archive(marked))
    assert dictionary.lookup(path, "apple")["matches"][0]["translations"] == ["simple fruit"]
    candidates = dictionary.choice_candidates(path)
    apple = next(candidate for candidate in candidates if candidate.headword == "apple")
    assert apple.translations == (("simple fruit", "simple fruit"),)


def test_checksum_rejected_before_parse(tmp_path: Path) -> None:
    path = tmp_path / "index.sqlite3"
    path.write_bytes(b"previous")
    with pytest.raises(ValueError, match="checksum"):
        dictionary.build(archive(), path)
    assert path.read_bytes() == b"previous"


def test_connections_closed(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    import sqlite3
    from typing import cast

    connections: list[sqlite3.Connection] = []
    connect = sqlite3.connect

    class Connection(sqlite3.Connection):
        closed = False

        def close(self) -> None:
            self.closed = True
            super().close()

    def tracking_connect(*args: object, **kwargs: object) -> sqlite3.Connection:
        db = cast(sqlite3.Connection, connect(*args, **kwargs, factory=Connection))  # type: ignore[call-overload]
        connections.append(db)
        return db

    monkeypatch.setattr(sqlite3, "connect", tracking_connect)
    path = tmp_path / "index.sqlite3"
    build_fixture(monkeypatch, path, archive())
    dictionary.lookup(path, "apple")
    dictionary.notices(path)
    assert len(connections) == 3
    assert all(isinstance(db, Connection) and db.closed for db in connections)


async def test_corrupt_index_rejected(
    app: FastAPI, alice: Client, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    import json
    import sqlite3

    path = tmp_path / "index.sqlite3"
    build_fixture(monkeypatch, path, archive())
    app.state.settings.dictionary_path = path
    with sqlite3.connect(path) as db:
        data = json.loads(db.execute("SELECT data FROM notices").fetchone()[0])
        data["source"]["id"] = "different"
        db.execute("UPDATE notices SET data = ?", (json.dumps(data),))
    lookup = await alice.post("/api/dictionary/lookup", json={"headword": "apple"})
    notices = await alice.get("/api/dictionary/notices")
    for response in (lookup, notices):
        assert response.status_code == 503
        assert response.json() == {"detail": "dictionary_unavailable"}
