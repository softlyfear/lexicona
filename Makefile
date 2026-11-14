.PHONY: install dictionary voices kokoro-install kokoro-voices fmt check check-backend check-frontend check-tooling

install:
	cd backend && uv sync --locked
	cd frontend && npm ci

dictionary:
	cd backend && uv run --locked python -m lexicona.infrastructure.dictionary build

voices: kokoro-voices

kokoro-install:
	UV_PYTHON_DOWNLOADS=never uv sync --locked --project runtime/kokoro --python 3.13

kokoro-voices:
	cd backend && uv run --locked python -m lexicona.infrastructure.kokoro download

fmt:
	cd backend && uv run --locked ruff check --fix ../tests ../scripts && uv run --locked ruff format ../tests ../scripts
	cd backend && uv run --locked ruff check --fix . && uv run --locked ruff format .
	cd frontend && npm run format

check: check-tooling check-backend check-frontend

check-tooling:
	cd backend && uv run --locked ruff check ../tests ../scripts
	cd backend && uv run --locked ruff format --check ../tests ../scripts
	python3 -m unittest discover -s tests -v

check-backend:
	cd backend && uv run --locked ruff format --check .
	cd backend && uv run --locked ruff check .
	cd backend && uv run --locked mypy
	cd backend && uv run --locked pytest

check-frontend:
	cd frontend && npm run format:check
	cd frontend && npm run lint
	cd frontend && npm test
	cd frontend && npm run build
