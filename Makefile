.PHONY: install fmt check check-backend check-frontend check-tooling codex-models codex

install:
	cd backend && uv sync --locked
	cd frontend && npm ci

fmt:
	cd backend && uv run --locked ruff check --fix ../.codex/hooks ../tests ../scripts && uv run --locked ruff format ../.codex/hooks ../tests ../scripts
	cd backend && uv run --locked ruff check --fix . && uv run --locked ruff format .
	cd frontend && npm run format

check: check-tooling check-backend check-frontend

check-tooling:
	cd backend && uv run --locked ruff check ../.codex/hooks ../tests ../scripts
	cd backend && uv run --locked ruff format --check ../.codex/hooks ../tests ../scripts
	python3 -m unittest discover -s tests -v

check-backend:
	cd backend && uv run --locked ruff format --check .
	cd backend && uv run --locked ruff check .
	cd backend && uv run --locked mypy
	cd backend && uv run --locked pytest

check-frontend:
	cd frontend && npm run format:check
	cd frontend && npm run lint
	cd frontend && npm run typecheck
	cd frontend && npm test
	cd frontend && npm run build

codex-models:
	python3 scripts/codex_models.py

codex:
	./scripts/codex
