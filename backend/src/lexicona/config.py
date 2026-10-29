from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="LEXICONA_", env_file=".env", extra="ignore")

    database_url: str = "sqlite+aiosqlite:///./data/lexicona.db"
    # Set to true behind HTTPS so the session cookie is never sent over plain HTTP.
    cookie_secure: bool = False
    session_days: int = 30
    # Directory with the built frontend; when set, the API also serves the SPA.
    static_dir: Path | None = None
