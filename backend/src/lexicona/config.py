from pathlib import Path
from typing import Literal

from pydantic import SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict

_ENV_FILE = Path("../.env" if Path.cwd().name == "backend" else ".env")


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="LEXICONA_", env_file=_ENV_FILE, extra="ignore")

    dictionary_path: Path = Path("data/dictionaries/eng-rus-2025.11.23.sqlite3")
    database_url: str = "sqlite+aiosqlite:///./data/lexicona.db"
    translation_provider: Literal["deepl", "openrouter"] = "deepl"
    deepl_api_key: SecretStr | None = None
    openrouter_api_key: SecretStr | None = None
    openrouter_model: str = "~deepseek/deepseek-flash-latest"
    # Set to true behind HTTPS so the session cookie is never sent over plain HTTP.
    cookie_secure: bool = False
    session_days: int = 30
    static_dir: Path | None = None
