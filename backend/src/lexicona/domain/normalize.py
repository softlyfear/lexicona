import unicodedata

_APOSTROPHES = str.maketrans({"’": "'", "‘": "'", "ʼ": "'", "`": "'"})


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


def hinted_text(current: str, answers: list[str]) -> tuple[str, bool]:
    """Return one more correct character and whether that text is a full answer.

    The result is a prefix of one expected answer. A wrong tail is replaced by
    that prefix. An already accepted answer is returned unchanged. Equal prefixes
    stay with the earlier answer, which is the primary translation.
    """
    if not answers:
        raise ValueError("no answers")
    folded = normalize(current)
    if folded and folded in {normalize(answer) for answer in answers}:
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
    return revealed, normalize(revealed) == normalize(best)


def _matched_prefix(folded: str, target: str) -> int:
    matched = 0
    for index in range(len(target) + 1):
        if folded.startswith(normalize(target[:index])):
            matched = index
        else:
            break
    return matched
