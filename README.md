# Lexicona

Многопользовательский личный EN/RU словарь и приложение для обучения.
Стек: FastAPI, SQLAlchemy async, SQLite/Alembic, React, TypeScript и Vite.

Реализованы миграции и SQLite/WAL, health API, адаптивный интерфейс с темами
и реальная проверка подключения. Backend также содержит защищённую CLI первого
администратора и API csrf/login/me/logout. Вход через интерфейс, регистрация
по приглашению, сохранение слов и упражнения ещё не реализованы.

## Локальный запуск

Подробные требования и команды: [docs/development.md](docs/development.md).
Нужны uv >=0.13.1, Python 3.13.16 и совместимые Node/npm:

```bash
(cd backend && uv sync --locked --python 3.13.16 --group dev)
(cd frontend && npm ci)
bash scripts/migrate.sh
bash scripts/dev.sh
```

UI: `http://127.0.0.1:5173`, API: `http://127.0.0.1:8000/api/v1/health/ready`.
Сервисы запускаются только на localhost. Не направляйте development-миграцию
на единственную копию важных данных; `.env` не загружается автоматически.

## Качество и поставка

Существующие проверки backend/frontend описаны в их README и документации
разработки; реальные браузерные E2E и security audits — в
[docs/testing.md](docs/testing.md). Скрытая мастерская и Hermes не нужны для
установки, запуска или тестирования приложения после clone.

Production deployment, Docker-поставка и backup/restore пока не реализованы.