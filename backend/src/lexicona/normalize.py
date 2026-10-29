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
