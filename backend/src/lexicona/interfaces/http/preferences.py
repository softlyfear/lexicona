"""Account preferences stored beside difficulty.

Training setup and speech choices travel with the account. Difficulty stays on
its own column. A damaged stored section is omitted instead of failing /me.
"""

import json
import re
from typing import Annotated, Any, Literal, Self

from pydantic import (
    BaseModel,
    BeforeValidator,
    ConfigDict,
    Field,
    StrictBool,
    StringConstraints,
    ValidationError,
    model_validator,
)

_RATES = {0.5, 0.75, 1.0, 1.25, 1.5}
_SERVER_VOICE = re.compile(r"[A-Za-z0-9._:-]{1,80}")
TagId = Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9_-]{1,32}$", strict=True)]


def _speech_rate(value: object) -> float:
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise ValueError("invalid speech rate")
    rate = float(value)
    if rate not in _RATES:
        raise ValueError("invalid speech rate")
    return rate


def _voice_uri(value: object) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or value == "" or len(value) > 300:
        raise ValueError("invalid voice uri")
    if any(ord(char) < 32 or ord(char) == 127 for char in value):
        raise ValueError("invalid voice uri")
    return value


def _server_voice(value: object) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or _SERVER_VOICE.fullmatch(value) is None:
        raise ValueError("invalid server voice")
    return value


def _tag_ids(value: object) -> object:
    if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
        return value
    return sorted(set(value))


SpeechRate = Annotated[float, BeforeValidator(_speech_rate)]
VoiceUri = Annotated[str | None, BeforeValidator(_voice_uri)]
ServerVoiceId = Annotated[str | None, BeforeValidator(_server_voice)]


class TrainingPreferences(BaseModel):
    model_config = ConfigDict(extra="forbid")

    mode: Literal["choice", "input", "matching"]
    direction: Literal["en_ru", "ru_en"]
    purpose: Literal["scheduled", "free"]
    include_new: StrictBool
    size: Annotated[int, Field(ge=1, le=1_000_000, strict=True)] | Literal["all"]
    tag_ids: Annotated[list[TagId], BeforeValidator(_tag_ids), Field(max_length=20)]
    progress_min: Annotated[int, Field(ge=0, le=1_000_000_000, strict=True)] | None
    progress_max: Annotated[int, Field(ge=0, le=1_000_000_000, strict=True)] | None
    order: Literal[
        "random",
        "reviewed_desc",
        "reviewed_asc",
        "created_desc",
        "created_asc",
        "progress_asc",
        "progress_desc",
    ]
    shuffle: StrictBool
    # Absent in setups saved before the toggle. Those stay closed to learned words.
    include_learned: StrictBool = False

    @model_validator(mode="after")
    def consistent(self) -> Self:
        if self.mode == "matching" and self.direction != "en_ru":
            raise ValueError("matching requires en_ru")
        if (
            self.progress_min is not None
            and self.progress_max is not None
            and self.progress_max < self.progress_min
        ):
            raise ValueError("progress_max must be at least progress_min")
        return self


class SpeechPreferences(BaseModel):
    model_config = ConfigDict(extra="forbid")

    en_locale: Annotated[str, Field(max_length=32, pattern=r"^en(?:-[A-Za-z0-9]{2,8}){0,3}$")]
    en_voice_uri: VoiceUri
    ru_voice_uri: VoiceUri
    rate: SpeechRate
    auto_prompt: StrictBool
    speak_en: StrictBool
    speak_ru: StrictBool
    engine_en: Literal["auto", "server", "browser"]
    engine_ru: Literal["auto", "server", "browser"]
    server_en_us: ServerVoiceId
    server_en_gb: ServerVoiceId
    server_ru: ServerVoiceId


class AccountPreferences(BaseModel):
    training: TrainingPreferences | None = None
    speech: SpeechPreferences | None = None


def preference_document(raw: object) -> dict[str, Any]:
    if isinstance(raw, str):
        try:
            raw = json.loads(raw)
        except json.JSONDecodeError:
            return {}
    if not isinstance(raw, dict):
        return {}
    return dict(raw)


def _section[T: BaseModel](model: type[T], value: object) -> T | None:
    if value is None:
        return None
    try:
        return model.model_validate(value)
    except ValidationError:
        return None


def public_preferences(raw: object) -> AccountPreferences:
    document = preference_document(raw)
    return AccountPreferences(
        training=_section(TrainingPreferences, document.get("training")),
        speech=_section(SpeechPreferences, document.get("speech")),
    )
