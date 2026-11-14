FROM node:22-alpine AS frontend
WORKDIR /app
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM python:3.14-slim
RUN pip install --no-cache-dir --upgrade pip==26.3 uv==0.13.5
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/opt/venv \
    PATH=/opt/venv/bin:$PATH
WORKDIR /app
COPY backend/pyproject.toml backend/uv.lock ./
RUN uv sync --locked --no-dev --no-install-project
COPY backend/ ./
RUN uv sync --locked --no-dev
RUN python -m lexicona.infrastructure.dictionary build --output /app/dictionaries/eng-rus-2025.11.23.sqlite3 \
    && chmod 0444 /app/dictionaries/eng-rus-2025.11.23.sqlite3
COPY --from=frontend /app/dist /app/static
COPY runtime/kokoro/pyproject.toml runtime/kokoro/uv.lock /opt/kokoro/
# The app environment is Python 3.14. Kokoro stays in its own 3.13 environment.
# uv installs that interpreter under UV_PYTHON_INSTALL_DIR. The default is
# /root/.local, which USER lexicona cannot execute.
RUN UV_PYTHON_INSTALL_DIR=/opt/uv-python UV_PROJECT_ENVIRONMENT=/opt/kokoro/.venv \
    uv sync --locked --no-dev --project /opt/kokoro --python 3.13 \
    && chmod -R a+rX /opt/kokoro /opt/uv-python

RUN apt-get update \
    && apt-get install -y --no-install-recommends --only-upgrade zlib1g \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 lexicona && mkdir /data && chown lexicona /data
USER lexicona
ENV LEXICONA_DATABASE_URL=sqlite+aiosqlite:////data/lexicona.db \
    LEXICONA_DICTIONARY_PATH=/app/dictionaries/eng-rus-2025.11.23.sqlite3 \
    LEXICONA_TTS_DIR=/data/tts \
    LEXICONA_KOKORO_PYTHON=/opt/kokoro/.venv/bin/python \
    LEXICONA_STATIC_DIR=/app/static \
    LEXICONA_COOKIE_SECURE=true
VOLUME /data
EXPOSE 8000
HEALTHCHECK CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/health')"
CMD ["sh", "-c", "alembic upgrade head && exec uvicorn lexicona.main:create_app --factory --host 0.0.0.0 --port 8000"]
