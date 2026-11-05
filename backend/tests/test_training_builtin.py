import pytest

from lexicona import distractors
from lexicona.normalize import normalize
from tests.conftest import Client, add_word


def test_filler_pool_uses_distinct_ordinary_words() -> None:
    entries = distractors.choice_candidates()
    assert len(entries) >= 120
    headwords = [entry.normalized_headword for entry in entries]
    glosses = [entry.translations[0][1] for entry in entries]
    assert len(headwords) == len(set(headwords))
    assert len(glosses) == len(set(glosses))
    for entry in entries:
        gloss = entry.translations[0][0]
        assert entry.headword.isascii() and "-" not in entry.headword
        assert len(entry.translations) == 1
        assert 2 <= len(gloss) <= 24 and gloss.count(" ") == 0
        assert not any(char.isdigit() for char in gloss)


@pytest.mark.parametrize("direction", ["en_ru", "ru_en"])
async def test_builtin_pool_fills_choice_from_ordinary_words(alice: Client, direction: str) -> None:
    await add_word(alice, "target", "цель")
    response = await alice.post("/api/training/sessions", json={"direction": direction})

    assert response.status_code == 201, response.text
    item = response.json()["items"][0]
    pool = distractors.choice_candidates()
    fillers = {entry.translations[0][0] for entry in pool} | {entry.headword for entry in pool}
    assert len(item["options"]) == 6
    assert len({normalize(option) for option in item["options"]}) == 6
    assert item["prompt"] in {"target", "цель"}
    assert set(item["options"]) - {"target", "цель"} <= fillers
    assert "ав-ав" not in item["options"]
    words = (await alice.get("/api/words")).json()
    assert [(word["headword"], word["translations"]) for word in words] == [("target", ["цель"])]


async def test_builtin_pool_is_not_needed_by_input(
    alice: Client, monkeypatch: pytest.MonkeyPatch
) -> None:
    def unexpected() -> None:
        raise AssertionError("input must not load built-in choice candidates")

    monkeypatch.setattr(distractors, "choice_candidates", unexpected)
    await add_word(alice, "target", "цель")
    response = await alice.post("/api/training/sessions", json={"mode": "input"})
    assert response.status_code == 201
    assert response.json()["items"][0]["options"] == []
