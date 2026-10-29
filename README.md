# Lexicona

Личный англо-русский словарь с тренировками. Работает в браузере на телефоне, планшете и
компьютере, у каждого пользователя свой словарь и свой прогресс.

Что уже есть:

- вход по логину и паролю (аккаунты создаёт администратор);
- словарь: слово, несколько переводов, транскрипция, пример, заметка, поиск, озвучка средствами браузера;
- тренировка «выбор из четырёх» в направлениях EN → RU и RU → EN, управление с клавиатуры (1–4, Enter);
- письменная тренировка EN → RU и RU → EN с проверкой ответа сервером;
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
Для архитектора и ревьюера задано семейство Sol с `high`, для четырёх исполнителей —
Terra с `high`. Модель основной сессии и разрешения остаются вашими.
Форматы сверены с официальной документацией: [hooks](https://learn.chatgpt.com/docs/hooks)
и [subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents).

Для wrapper нужны Python 3.11+ и установленный авторизованный Codex CLI; `make install`
их не устанавливает. Для запуска Codex из проекта используйте `./scripts/codex` или
`make codex`: перед запуском
wrapper обновит модели ролей из каталога Codex. Команда `make codex-models` только обновляет
модели; при недоступности каталога остаются текущие. Прямой запуск Codex desktop обходит
wrapper, а уже запущенная сессия автоматически не перезагружается. При появлении новых
версий изменятся отслеживаемые файлы `.codex/agents/*.toml`: это обычный diff для следующего
коммита, скрипт сам не коммитит. Если обновлений нет, файлы не перезаписываются.

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
