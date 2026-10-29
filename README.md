# Lexicona

Личный англо-русский словарь с тренировками. Работает в браузере на телефоне, планшете и
компьютере, у каждого пользователя свой словарь и свой прогресс.

Что уже есть:

- вход по логину и паролю (аккаунты создаёт администратор);
- словарь: слово, несколько переводов, транскрипция, пример, заметка, поиск, озвучка средствами браузера;
- тренировка «выбор из четырёх» в направлениях EN → RU и RU → EN, управление с клавиатуры (1–4, Enter);
- прогресс слова 0–100 % с пятью уровнями сложности.

## Локальный запуск

Нужны [uv](https://docs.astral.sh/uv/) и Node.js 22+.

```sh
# API на http://127.0.0.1:8000
cd backend
uv sync
uv run alembic upgrade head
uv run lexicona-admin create-user me --admin
uv run uvicorn lexicona.main:create_app --factory --reload

# в другом терминале: интерфейс на http://localhost:5173
cd frontend
npm install
npm run dev
```

База по умолчанию лежит в `backend/data/lexicona.db`. Путь задаётся переменной `LEXICONA_DATABASE_URL`.

## Проверки

```sh
make install    # воспроизводимая установка из lock-файлов
make check      # хук: тесты; backend: ruff/mypy/pytest; frontend: формат/lint/types/test/build
make fmt        # исправление форматирования
```

GitHub Actions вызывает те же цели Makefile на push в main и pull request.

Правила и конвейер Codex — [AGENTS.md](AGENTS.md), роли — `.codex/agents/`,
текущий тикет — `.codex/TASKS.md`. После открытия доверенного проекта просмотрите
и включите хук через `/hooks`. Хук форматирует файлы после `apply_patch`;
после изменений через shell используйте `make fmt`. Полные проверки — `make check`.
Модель и разрешения наследуются от ваших настроек Codex.
Форматы сверены с официальной документацией: [hooks](https://learn.chatgpt.com/docs/hooks)
и [subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents).

## Продакшен

```sh
cp .env.example .env    # указать LEXICONA_DOMAIN
docker compose up -d --build
docker compose exec app lexicona-admin create-user me --admin
```

Caddy сам получает TLS-сертификат для домена. База лежит в volume `data`, бэкап — копия
`/data/lexicona.db` (например, через `sqlite3 .backup`).

## Лицензия

MIT
