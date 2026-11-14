import unicodedata

_APOSTROPHES = str.maketrans({"’": "'", "‘": "'", "ʼ": "'", "`": "'"})
_ANSWER_HYPHENS = frozenset("-‐‑﹣－")


def normalize(text: str) -> str:
    """Normalize an answer or a dictionary entry for comparison.

    Deliberately conservative: punctuation, articles and negations stay significant,
    so "can't" never equals "can". Only a single trailing period is dropped.
    """
    result = unicodedata.normalize("NFC", text)
    result = " ".join(result.split())
    result = result.casefold().translate(_APOSTROPHES)
    result = result.replace("ё", "е")
    if result.endswith(".") and not result.endswith(".."):
        result = result[:-1].rstrip()
    return result


def _answer_characters(text: str) -> list[str]:
    """Keep source positions so hints can return canonical prefixes."""
    characters = []
    for index, char in enumerate(text):
        internal = (
            0 < index < len(text) - 1 and text[index - 1].isalpha() and text[index + 1].isalpha()
        )
        if internal and char.translate(_APOSTROPHES) == "'":
            characters.append("")
        elif internal and char in _ANSWER_HYPHENS:
            characters.append(" ")
        else:
            characters.append(char)
    return characters


def normalize_answer(text: str) -> str:
    """Allow internal apostrophe omission and letter-to-letter hyphen/space variants.

    This is not dictionary identity or fuzzy spelling. Other punctuation and word
    boundaries remain significant; in particular, "can't" still differs from "can".
    """
    return normalize("".join(_answer_characters(unicodedata.normalize("NFC", text))))


def hinted_text(current: str, answers: list[str]) -> tuple[str, bool]:
    """Return one more correct character and whether that text is a full answer.

    The result is a prefix of one expected answer. A wrong tail is replaced by
    that prefix. An already accepted answer is returned unchanged. Equal prefixes
    stay with the earlier answer, which is the primary translation.
    """
    if not answers:
        raise ValueError("no answers")
    folded = normalize_answer(current)
    if folded and folded in {normalize_answer(answer) for answer in answers}:
        return current, True
    best = answers[0]
    best_matched = -1
    for answer in answers:
        matched = _matched_prefix(folded, answer)
        # A shorter synonym must not replace the translation already being typed.
        if matched > best_matched:
            best = answer
            best_matched = matched
    if best_matched >= len(best):
        return best, True
    revealed = best[: best_matched + 1]
    return revealed, normalize_answer(revealed) == normalize_answer(best)


def _matched_prefix(folded: str, target: str) -> int:
    matched = 0
    characters = _answer_characters(target)
    for index in range(len(target) + 1):
        if folded.startswith(normalize("".join(characters[:index]))):
            matched = index
        else:
            break
    return matched
