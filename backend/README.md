# Lexicona backend foundation

Ограниченный срез LX-001/LX-002: FastAPI application factory, health endpoints,
файловый SQLite, явные Alembic migrations и локальные quality gates.
Аккаунты, словарь и тренировочные percentage/SRS policies здесь ещё не реализованы.

## Окружение и запуск

Команды выполняются из `backend/` относительно корня репозитория. Нужен `uv>=0.13.1`;
`.python-version` фиксирует независимый project runtime Python 3.13.16,
`uv.lock` — версии зависимостей. Не устанавливайте их в Python окружения агента.

```sh
uv sync --locked --python 3.13.16 --group dev
.venv/bin/alembic upgrade head
.venv/bin/uvicorn lexicona.app:create_app --factory --host 127.0.0.1 --port 8000 --workers 1 --no-proxy-headers --no-access-log
```

По умолчанию используется `data/lexicona.sqlite3` относительно текущей директории.
До отдельно проверенного trusted ingress forwarded headers не переписывают
ASGI peer; raw Uvicorn access log отключён, чтобы не записывать произвольный URL.
Это не готовый application audit logger и не доказательство будущего auth rate limit.
`LEXICONA_DATABASE_URL` переопределяет URL и для приложения, и для Alembic:
поддерживаются только файловые `sqlite+aiosqlite` URL без query parameters.
Запуск приложения **не выполняет миграции**. Начальная миграция фиксирует только
revision boundary `0001_foundation`, без фиктивных бизнес-таблиц.

- `GET /api/v1/health/live`: `200 {"status":"alive"}`, независимо от SQLite/schema.
- `GET /api/v1/health/ready`: `200 {"status":"ready"}` только при доступной БД
  и единственной записи текущего revision в `alembic_version`.
- Без миграции, при другом/нескольких revision или недоступной БД readiness
  возвращает `503 {"error":{"code":"not_ready","message":"Service is not ready"}}`
  с `Retry-After: 1` (совет о повторной read-only probe, не обещание срока recovery).
  SQL, filesystem paths и параметры не попадают в этот ответ. Filesystem setup
  выполняется при подключении, а не в factory: недоступный parent (в том числе
  обычный файл или permission denied) не мешает liveness/startup. Подключение
  повторяет setup после восстановления пути; миграция по-прежнему только явная.
- Оба endpoint возвращают `Cache-Control: no-store`.

Один worker, pool size 3/max overflow 0/checkout timeout 5 секунд, отдельная
`AsyncSession` на unit of work. На каждом новом physical connection явно
устанавливаются WAL, foreign keys, `busy_timeout=5000`, `synchronous=FULL`.
Последующие checkout сохраняют эти PRAGMA; приложение не меняет их в UoW.
Выбрана только SQLAlchemy-managed BEGIN policy (`isolation_level=None` у драйвера),
без смешивания с driver `autocommit=False`. Обычный UoW использует `BEGIN`,
`unit_of_work(write=True)` резервирует writer через `BEGIN IMMEDIATE` **до** yield.
Оба варианта откатывают DDL/released savepoint вместе с внешней транзакцией.

При busy write UoW завершается rollback без выполнения application body и без
автоматического retry. Подготовка/хеширование/разбор/сеть должны выполняться **до**
входа в write UoW; финальные проверки состояния и SQL — внутри. Сейчас write API
нет: replay-safe business retry/DB_BUSY receipt semantics будут проверяться при
первом таком endpoint, а не подменяться универсальным retry framework заранее.
Readiness безопасно отвечает 503 при DB lock/ошибке/исчерпании pool и восстанавливает
200 после снятия причины. При обычном WAL writer reader/readiness не блокируются.
Ожидание lock до 5 секунд, checkout до 5 секунд: суммарный DB wait budget до
10 секунд без retry (меньше foundation лимита 12 секунд); это не end-to-end SLA.

## Проверки

### База сравнения и provenance

Gate намеренно строже changed-only: **все** runtime `.py` в `src`, `migrations`,
`tools` должны пройти 100% statements и branch outcomes. Поэтому новые,
untracked, перемещённые и baseline-неизменённые файлы не пропускаются. Отдельный
алгоритм diff coverage не нужен: при отдельно проверенном B=100/100 любой новый
missing в неизменённом файле H блокирует H, переименование не обнуляет долг.
Это не разрешает пропускать тесты B или объявлять B прошедшим по отчёту H.

Перед срезом координатор фиксирует immutable SHA B, запускает полный набор B
в отдельном checkout/project environment из его lock, сохраняет команду/cwd/exit,
coverage JSON и исходные config/source hashes. Затем в H выполняется весь набор
ниже. При runtime/toolchain upgrade различия B/H явно описываются в handoff;
прошлые failures не превращаются в pass. Не использовать изменяемый `main` как B.

Дополнительные параметры того же gate сохраняют машинный manifest, в том числе
при coverage failure:

```sh
.venv/bin/python -m tools.coverage_gate .local-reports/coverage.json src migrations tools \
  --baseline 7ac0de323005ac778b378e712e8b0a9899b4274a \
  --manifest .local-reports/source-manifest.json
```

SHA в примере — исторический foundation B; для нового среза подставляется его
собственный согласованный B. Manifest содержит все source paths/SHA-256,
branchless status, report hash/version, passed, точный resolved baseline SHA,
`git diff -z -M --name-status` tokens (`R100`, old path, new path для rename)
и отдельный `git ls-files --others` inventory untracked. Stage не требуется;
Git diff относится к production roots, а не чужим параллельным изменениям.
Inventory файловой системы остаётся определяющим даже для ignored/untracked.
Пустой `.py` без executable statements и `.pyi` typing stub имеют явный
`not_applicable` с причиной, а не фиктивный 100/0. Python type aliases/classes
в runtime `.py` не получают type-only исключения. Удаления видны в Git mapping;
review проверяет, что проверки не удалены ради зелёного.

JSON принимается только с проверенными `meta.format=3`, `meta.version=7.16.2`
и строгими типами всех используемых обязательных полей, включая
`executed_branches`/`missing_branches`; отсутствие не заменяется `[]`.
Upgrade coverage требует обновить lock, проверить schema/API и probes вместе.
Manifest связывает отчёт с проверенным snapshot, но не является цифровой подписью:
тесты и gate запускаются на одном неизменённом дереве до review/commit.

### Команды

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
