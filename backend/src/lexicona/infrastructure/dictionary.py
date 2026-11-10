import argparse
import hashlib
import io
import json
import lzma
import os
import re
import sqlite3
import tarfile
import tempfile
import unicodedata
import urllib.request
import xml.etree.ElementTree as ET
from contextlib import closing
from difflib import get_close_matches
from pathlib import Path, PurePosixPath
from typing import Any

from lexicona.config import Settings

# Explicit re-export: callers and mypy look up ChoiceEntry on this module.
from lexicona.domain.choice import ChoiceEntry as ChoiceEntry
from lexicona.domain.normalize import normalize

SOURCE_ID = "freedict-wikdict-eng-rus-2025.11.23"
SHA256 = "f3dadcc29d7df6e77edb13b98a2ba2c3fac002852eddd8b557637f0b13d39c39"
URL = "https://download.freedict.org/dictionaries/eng-rus/2025.11.23/freedict-eng-rus-2025.11.23.src.tar.xz"
SOURCE = {
    "id": SOURCE_ID,
    "title": "English-Русский FreeDict+WikDict dictionary",
    "edition": "2025.11.23",
    "license": "CC BY-SA 3.0 Unported",
    "license_url": "https://creativecommons.org/licenses/by-sa/3.0/legalcode",
    "source_url": URL,
    "credits": "Karl Bartel; WikDict; Wiktionary.org via DBnary; FreeDict",
}
TRANSFORMATIONS = [
    "Locally indexed TEI entries in source order; NFC, casefold and whitespace "
    "normalization for lookup.",
    "Translation and transcription lists are bounded; original display text is retained.",
]
NS = "{http://www.tei-c.org/ns/1.0}"
DOCTYPE = b'<!DOCTYPE TEI SYSTEM "freedict-P5.dtd">'


def key(value: str) -> str:
    return " ".join(unicodedata.normalize("NFC", value).split()).casefold()


def display(value: str) -> str:
    return " ".join(unicodedata.normalize("NFC", value).split())


def clean_translation(value: str) -> str:
    return re.sub(
        r"\[\[([^\[\]|]+)(?:\|([^\[\]]+))?\]\]",
        lambda match: match.group(2) or match.group(1),
        value,
    )


def _archive(data: bytes) -> tuple[bytes, bytes]:
    if len(data) > 6_000_000 or hashlib.sha256(data).hexdigest() != SHA256:
        raise ValueError("archive checksum or size invalid")
    decoder = lzma.LZMADecompressor(memlimit=128 * 1024 * 1024)
    raw = decoder.decompress(data, max_length=64 * 1024 * 1024 + 1)
    if len(raw) > 64 * 1024 * 1024 or not decoder.eof or decoder.unused_data:
        raise ValueError("archive expansion limit exceeded")
    found: dict[str, bytes] = {}
    total = 0
    with tarfile.open(fileobj=io.BytesIO(raw), mode="r:") as archive:
        members = archive.getmembers()
        if len(members) > 100:
            raise ValueError("too many archive members")
        for member in members:
            path = PurePosixPath(member.name)
            if path.is_absolute() or ".." in path.parts or not member.isfile():
                raise ValueError("unsafe archive member")
            total += member.size
            if member.size > 45 * 1024 * 1024 or total > 60 * 1024 * 1024:
                raise ValueError("archive member limit exceeded")
            if member.name in {"eng-rus/eng-rus.tei", "eng-rus/COPYING"}:
                if member.name in found:
                    raise ValueError("duplicate archive member")
                file = archive.extractfile(member)
                if file is None:
                    raise ValueError("missing archive member")
                found[member.name] = file.read()
    if set(found) != {"eng-rus/eng-rus.tei", "eng-rus/COPYING"}:
        raise ValueError("missing archive members")
    return found["eng-rus/eng-rus.tei"], found["eng-rus/COPYING"]


def _fields(elements: list[ET.Element], limit: int, length: int) -> list[str]:
    result: list[str] = []
    for element in elements:
        value = display("".join(element.itertext()))
        if value and len(value) <= length and value not in result:
            result.append(value)
            if len(result) == limit:
                break
    return result


def build(data: bytes, output: Path) -> None:
    tei, copying = _archive(data)
    if (
        len(tei) > 40 * 1024 * 1024
        or b"<!ENTITY" in tei.upper()
        or tei.count(DOCTYPE) != 1
        or tei.upper().count(b"<!DOCTYPE") != 1
    ):
        raise ValueError("unsafe XML declaration or size")
    start = tei.index(b"<teiHeader")
    end = tei.index(b"</teiHeader>", start) + len(b"</teiHeader>")
    header = tei[start:end].decode("utf-8")
    root = ET.fromstring(tei.replace(DOCTYPE, b"", 1))  # noqa: S314 — declarations rejected above
    entries = root.findall(f".//{NS}entry")
    if not entries or len(entries) > 70_000 or len(header) > 1_000_000 or len(copying) > 1_000_000:
        raise ValueError("XML entry or notices limit exceeded")
    output.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=".dictionary-", suffix=".sqlite3", dir=output.parent)
    os.close(fd)
    try:
        with closing(sqlite3.connect(name)) as db, db:
            db.execute(
                "CREATE TABLE entries (entry_id INTEGER PRIMARY KEY, headword TEXT NOT NULL, "
                "normalized TEXT NOT NULL, part_of_speech TEXT, translations TEXT NOT NULL, "
                "transcriptions TEXT NOT NULL)"
            )
            db.execute("CREATE INDEX entries_normalized ON entries(normalized)")
            db.execute("CREATE TABLE notices (data TEXT NOT NULL)")
            db.execute(
                "INSERT INTO notices VALUES (?)",
                (
                    json.dumps(
                        {
                            "source": SOURCE,
                            "sha256": SHA256,
                            "copying": copying.decode("utf-8"),
                            "tei_header": header,
                            "transformations": TRANSFORMATIONS,
                        },
                        ensure_ascii=False,
                    ),
                ),
            )
            for ordinal, entry in enumerate(entries, 1):
                heads = _fields(entry.findall(f"{NS}form/{NS}orth"), 1, 200)
                if not heads:
                    continue
                pos = _fields(entry.findall(f"{NS}gramGrp/{NS}pos"), 1, 100)
                translations = _fields(
                    entry.findall(
                        f".//{NS}cit[@type='trans'][@{{http://www.w3.org/XML/1998/namespace}}lang='ru']/{NS}quote"
                    ),
                    20,
                    200,
                )
                transcriptions = _fields(entry.findall(f"{NS}form/{NS}pron"), 20, 300)
                db.execute(
                    "INSERT INTO entries VALUES (?, ?, ?, ?, ?, ?)",
                    (
                        ordinal,
                        heads[0],
                        key(heads[0]),
                        pos[0] if pos else None,
                        json.dumps(translations, ensure_ascii=False),
                        json.dumps(transcriptions, ensure_ascii=False),
                    ),
                )
            if db.execute("PRAGMA integrity_check").fetchone() != ("ok",):
                raise ValueError("index integrity check failed")
        os.replace(name, output)
    finally:
        Path(name).unlink(missing_ok=True)


def _connect(path: Path) -> sqlite3.Connection:
    db = sqlite3.connect(path.resolve().as_uri() + "?mode=ro&immutable=1", uri=True)
    try:
        db.execute("PRAGMA trusted_schema=OFF")
        db.execute("PRAGMA query_only=ON")
    except BaseException:
        db.close()
        raise
    return db


def _notices(db: sqlite3.Connection) -> dict[str, Any]:
    rows = db.execute(
        "SELECT CASE WHEN length(data) <= 2100000 THEN data END FROM notices LIMIT 2"
    ).fetchall()
    if len(rows) != 1 or not isinstance(rows[0][0], str):
        raise ValueError("invalid notices")
    result = json.loads(rows[0][0])
    if (
        not isinstance(result, dict)
        or result.get("source") != SOURCE
        or result.get("sha256") != SHA256
    ):
        raise ValueError("wrong source")
    for field in ("copying", "tei_header"):
        value = result.get(field)
        if not isinstance(value, str) or not 1 <= len(value) <= 1_000_000:
            raise ValueError("invalid notices")
    transformations = result.get("transformations")
    if (
        not isinstance(transformations, list)
        or not 1 <= len(transformations) <= 20
        or any(not isinstance(item, str) or not 1 <= len(item) <= 1000 for item in transformations)
    ):
        raise ValueError("invalid transformations")
    return {
        "source": SOURCE,
        "sha256": SHA256,
        "copying": result["copying"],
        "tei_header": result["tei_header"],
        "transformations": transformations,
    }


def _list_field(value: Any, limit: int) -> list[str]:
    if not isinstance(value, str) or len(value) > 30_000:
        raise ValueError("invalid entry")
    values = json.loads(value)
    if (
        not isinstance(values, list)
        or len(values) > 20
        or any(not isinstance(item, str) or not 1 <= len(item) <= limit for item in values)
    ):
        raise ValueError("invalid entry")
    return values


def lookup(path: Path, headword: str) -> dict[str, Any]:
    with closing(_connect(path)) as db:
        _notices(db)
        rows = db.execute(
            "SELECT entry_id, CASE WHEN length(headword) <= 200 THEN headword END, "
            "part_of_speech IS NULL OR length(part_of_speech) <= 100, "
            "CASE WHEN length(part_of_speech) <= 100 THEN part_of_speech END, "
            "CASE WHEN length(translations) <= 30000 THEN translations END, "
            "CASE WHEN length(transcriptions) <= 30000 THEN transcriptions END "
            "FROM entries WHERE normalized = ? ORDER BY "
            "CASE WHEN headword = ? THEN 0 ELSE 1 END, entry_id LIMIT 20",
            (key(headword), display(headword)),
        ).fetchall()
        suggestions: list[str] = []
        if not rows and len(key(headword)) >= 2:
            normalized = key(headword)
            candidates = db.execute(
                "SELECT normalized, "
                "COALESCE(MIN(CASE WHEN headword = normalized THEN headword END), MIN(headword)) "
                "FROM entries WHERE normalized != ? AND length(normalized) BETWEEN ? AND ? "
                "GROUP BY normalized",
                (normalized, max(2, len(normalized) - 2), len(normalized) + 2),
            ).fetchall()
            spellings: dict[str, str] = {}
            for candidate, spelling in candidates:
                if (
                    not isinstance(candidate, str)
                    or not isinstance(spelling, str)
                    or key(candidate) != candidate
                    or key(spelling) != candidate
                ):
                    raise ValueError("invalid entry")
                spellings[candidate] = spelling
            suggestions = [
                spellings[candidate]
                for candidate in get_close_matches(normalized, list(spellings), n=3, cutoff=0.75)
            ]
    matches = []
    for entry_id, spelling, pos_valid, pos, translations, transcriptions in rows:
        if (
            type(entry_id) is not int
            or entry_id <= 0
            or not isinstance(spelling, str)
            or not spelling
            or key(spelling) != key(headword)
            or not pos_valid
            or (pos is not None and not isinstance(pos, str))
        ):
            raise ValueError("invalid entry")
        matches.append(
            {
                "entry_id": entry_id,
                "headword": spelling,
                "part_of_speech": pos,
                "translations": list(
                    dict.fromkeys(
                        clean_translation(value) for value in _list_field(translations, 200)
                    )
                ),
                "transcriptions": _list_field(transcriptions, 300),
                "match": "exact" if spelling == display(headword) else "normalized",
            }
        )
    return {"source": SOURCE, "matches": matches, "spelling_suggestions": suggestions}


def choice_candidates(path: Path, limit: int = 120) -> list[ChoiceEntry]:
    if type(limit) is not int or not 1 <= limit <= 200:
        raise ValueError("invalid choice candidate limit")
    with closing(_connect(path)) as db:
        _notices(db)
        rows = db.execute(
            "SELECT entry_id, CASE WHEN length(headword) <= 200 THEN headword END, "
            "CASE WHEN length(translations) <= 30000 THEN translations END "
            "FROM entries WHERE translations != '[]' ORDER BY RANDOM() LIMIT ?",
            (limit,),
        ).fetchall()
    candidates = []
    for entry_id, spelling, raw_translations in rows:
        if (
            type(entry_id) is not int
            or entry_id <= 0
            or not isinstance(spelling, str)
            or not normalize(spelling)
        ):
            raise ValueError("invalid entry")
        translations: dict[str, str] = {}
        for value in _list_field(raw_translations, 200):
            text = clean_translation(value).replace("\u0301", "")
            normalized = normalize(text)
            if normalized:
                translations.setdefault(normalized, text)
        if translations:
            candidates.append(
                ChoiceEntry(
                    entry_id=entry_id,
                    headword=spelling,
                    normalized_headword=normalize(spelling),
                    translations=tuple((text, key) for key, text in translations.items()),
                )
            )
    return candidates


def notices(path: Path) -> dict[str, Any]:
    with closing(_connect(path)) as db:
        return _notices(db)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(
        self, req: Any, fp: Any, code: int, msg: str, headers: Any, newurl: str
    ) -> None:
        return None


def main() -> None:
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="command", required=True)
    command = commands.add_parser("build")
    command.add_argument("--archive", type=Path)
    command.add_argument("--output", type=Path, default=Settings().dictionary_path)
    args = parser.parse_args()
    if args.archive:
        with args.archive.open("rb") as file:
            data = file.read(6_000_001)
    else:
        with urllib.request.build_opener(_NoRedirect()).open(URL, timeout=30) as response:
            data = response.read(6_000_001)
    build(data, args.output)


if __name__ == "__main__":
    main()
