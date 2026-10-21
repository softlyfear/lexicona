"""Private test server factory: explicit origin, default real password profile."""

import os

from fastapi import FastAPI

from lexicona.app import create_app
from lexicona.auth.config import AuthConfig


def factory() -> FastAPI:
    return create_app(
        auth_config=AuthConfig(public_origin=os.environ["LEXICONA_TEST_ORIGIN"])
    )
