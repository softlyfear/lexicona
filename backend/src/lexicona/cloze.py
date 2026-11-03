import unicodedata

_APOSTROPHES = str.maketrans({"’": "'", "‘": "'", "ʼ": "'", "`": "'"})


def _key(text: str) -> str:
    return " ".join(unicodedata.normalize("NFC", text).split()).casefold().translate(_APOSTROPHES)


def _boundary_character(char: str) -> bool:
    return char.isalnum() or unicodedata.category(char).startswith("M") or char in "_'-‐‑"


def mask_example(headword: str, example: str | None) -> str | None:
    """Mask exactly one complete occurrence, preserving the original surrounding text.

    Mapping normalized characters back to source spans avoids slicing through a combining
    sequence, casefold expansion, or a run of whitespace. If mapping is ambiguous, reject.
    """
    wanted = _key(headword)
    if not wanted or not example or not example.strip():
        return None

    normalized: list[str] = []
    spans: list[tuple[int, int]] = []
    index = 0
    while index < len(example):
        start = index
        if example[index].isspace():
            index += 1
            while index < len(example) and example[index].isspace():
                index += 1
            chunk = " "
        else:
            index += 1
            while index < len(example) and unicodedata.category(example[index]).startswith("M"):
                index += 1
            chunk = (
                unicodedata.normalize("NFC", example[start:index])
                .casefold()
                .translate(_APOSTROPHES)
            )
        normalized.append(chunk)
        spans.extend([(start, index)] * len(chunk))
    text = "".join(normalized)
    # Canonical composition across source chunks would make the offsets ambiguous.
    if text.strip() != _key(example):
        return None

    matches: list[tuple[int, int]] = []
    offset = 0
    while (found := text.find(wanted, offset)) != -1:
        end = found + len(wanted)
        offset = found + 1  # Include overlapping occurrences.
        if found and _boundary_character(text[found - 1]):
            continue
        if end < len(text) and _boundary_character(text[end]):
            continue
        if found and spans[found] == spans[found - 1]:
            continue
        if end < len(text) and spans[end - 1] == spans[end]:
            continue
        matches.append((spans[found][0], spans[end - 1][1]))
        if len(matches) > 1:
            return None
    if len(matches) != 1:
        return None
    start, end = matches[0]
    return f"{example[:start]}____{example[end:]}"
