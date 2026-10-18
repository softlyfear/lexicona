# Lexicona backend foundation

Ограниченный срез LX-001/LX-002: FastAPI application factory, health endpoints,
файловый SQLite, явные Alembic migrations и локальные quality gates.
Аккаунты, словарь и тренировочные percentage/SRS policies здесь ещё не реализованы.

## Окружение и запуск

Команды выполняются из `backend/` относительно корня репозитория. Нужен `uv`;
`.python-version` фиксирует независимый project runtime Python 3.13.14,
`uv.lock` — версии зависимостей. Не устанавливайте их в Python окружения агента.

```sh
uv sync --locked
.venv/bin/alembic upgrade head
.venv/bin/uvicorn lexicona.app:create_app --factory --host 127.0.0.1 --port 8000 --workers 1
```

По умолчанию используется `data/lexicona.sqlite3` относительно текущей директории.
`LEXICONA_DATABASE_URL` переопределяет URL и для приложения, и для Alembic:
поддерживаются только файловые `sqlite+aiosqlite` URL без query parameters.
Запуск приложения **не выполняет миграции**. Начальная миграция фиксирует только
revision boundary `0001_foundation`, без фиктивных бизнес-таблиц.

- `GET /api/v1/health/live`: `200 {"status":"alive"}`, независимо от SQLite/schema.
- `GET /api/v1/health/ready`: `200 {"status":"ready"}` только при доступной БД
  и единственной записи текущего revision в `alembic_version`.
- Без миграции, при другом/нескольких revision или недоступной БД readiness
  возвращает `503 {"error":{"code":"not_ready","message":"Service is not ready"}}`.
  SQL, filesystem paths и параметры не попадают в этот ответ. Filesystem setup
  выполняется при подключении, а не в factory: недоступный parent (в том числе
  обычный файл или permission denied) не мешает liveness/startup. Подключение
  повторяет setup после восстановления пути; миграция по-прежнему только явная.
- Оба endpoint возвращают `Cache-Control: no-store`.

Один worker, bounded pool, отдельная `AsyncSession` на unit of work. На каждом
connection включены WAL, foreign keys и `busy_timeout=5000`; явный `BEGIN`
обеспечивает rollback DDL и released savepoint вместе с внешней транзакцией.

## Проверки

```sh
mkdir -p .local-reports
.venv/bin/ruff check src tests migrations tools
.venv/bin/ruff format --check src tests migrations tools
.venv/bin/mypy --strict src tests migrations tools
.venv/bin/coverage run -m pytest -q
.venv/bin/coverage json -o .local-reports/coverage.json
.venv/bin/coverage report
.venv/bin/python -m tools.coverage_gate .local-reports/coverage.json src migrations tools
```

Все команды должны завершаться с exit code 0. Coverage собирает branches и не
исключает migrations/tools. Последний gate независимо перечисляет все `.py`
файлы в переданных production roots и раздельно отклоняет отсутствующий или
неисполненный source, missing lines и missing branches. Он также запрещает
excluded lines, отчёт без branch measurement, отсутствующие roots и пустой
source inventory. Округлённый общий процент не является доказательством.
Реестр согласованных исключений пуст: comment-токены Python проверяются на
запрещённые coverage pragmas (не строки/многострочные литералы). Gate независимо
пересчитывает statements/branch exits по текущему source без стандартных и
пользовательских report exclusion regexes и сверяет их с `executed_lines` и
`executed_branches` настоящего JSON. Поэтому подавленный `missing_branches`
(включая custom partial-branch patterns) не доказывает полноту покрытия. Отсутствие
arc evidence — отказ, не синтез из выполненных строк. Dev minimum coverage
соответствует проверенной lock-версии с используемыми API анализа/cleanup.

Тесты проверяют реальные online upgrade/re-upgrade/downgrade, offline SQL,
health/error contract, file-backed WAL/FK/busy timeout, commit/rollback,
savepoint semantics и параллельные reader/writer connections. JSON reports,
БД, WAL/SHM/journal files и `.venv` исключены из Git.

Проверки этого среза не заменяют независимое code review, frontend integration,
backup/restore, load testing, deployment или физическую проверку TTS.
