from pathlib import Path

import pytest
from fastapi import FastAPI

from lexicona import dictionary
from tests.conftest import Client, add_word
from tests.test_dictionary import archive, build_fixture

TEI = """<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE TEI SYSTEM "freedict-P5.dtd">
<TEI xmlns="http://www.tei-c.org/ns/1.0"><teiHeader><fileDesc>credits</fileDesc></teiHeader>
<text><body>
<entry><form><orth>alpha</orth></form><sense>
<cit type="trans" xml:lang="ru"><quote>пе́рвый</quote></cit></sense></entry>
<entry><form><orth>beta</orth></form><sense>
<cit type="trans" xml:lang="ru"><quote>второй</quote></cit></sense></entry>
<entry><form><orth>gamma</orth></form><sense>
<cit type="trans" xml:lang="ru"><quote>третий</quote></cit></sense></entry>
<entry><form><orth>delta</orth></form><sense>
<cit type="trans" xml:lang="ru"><quote>четвёртый</quote></cit></sense></entry>
<entry><form><orth>epsilon</orth></form><sense>
<cit type="trans" xml:lang="ru"><quote>пятый</quote></cit></sense></entry>
<entry><form><orth>ambiguous</orth></form><sense>
<cit type="trans" xml:lang="ru"><quote>цель</quote></cit></sense></entry>
</body></text></TEI>""".encode()


@pytest.mark.parametrize(
    ("direction", "translation", "prompt", "options"),
    [
        (
            "en_ru",
            "це́ль",
            "target",
            {"це́ль", "первый", "второй", "третий", "четвёртый", "пятый"},
        ),
        (
            "ru_en",
            "це́ль",
            "це́ль",
            {"target", "alpha", "beta", "gamma", "delta", "epsilon"},
        ),
    ],
)
async def test_builtin_pool_supplies_only_unambiguous_hidden_distractors(
    app: FastAPI,
    alice: Client,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    direction: str,
    translation: str,
    prompt: str,
    options: set[str],
) -> None:
    path = tmp_path / "index.sqlite3"
    build_fixture(monkeypatch, path, archive(TEI))
    app.state.settings.dictionary_path = path
    await add_word(alice, "target", translation)

    response = await alice.post("/api/training/sessions", json={"direction": direction})

    assert response.status_code == 201, response.text
    items = response.json()["items"]
    assert len(items) == 1
    assert items[0]["prompt"] == prompt
    assert set(items[0]["options"]) == options
    assert len(items[0]["options"]) == 6
    words = (await alice.get("/api/words")).json()
    assert [(word["headword"], word["translations"]) for word in words] == [
        ("target", [translation])
    ]


async def test_builtin_pool_is_not_needed_by_input(
    alice: Client, monkeypatch: pytest.MonkeyPatch
) -> None:
    def unexpected(path: Path) -> None:
        raise AssertionError("input must not load built-in choice candidates")

    monkeypatch.setattr(dictionary, "choice_candidates", unexpected)
    await add_word(alice, "target", "цель")
    response = await alice.post("/api/training/sessions", json={"mode": "input"})
    assert response.status_code == 201
    assert response.json()["items"][0]["options"] == []
