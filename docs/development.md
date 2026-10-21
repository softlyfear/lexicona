# Локальная разработка (Linux)

Это инструкции для development foundation, не production deployment и не
подтверждение готовности полного MVP. Нужен checkout, содержащий `backend/`,
`frontend/` и `scripts/`; скрытая мастерская и Hermes для запуска не нужны.
Все команды ниже выполняются из корня репозитория, кроме явно указанного `cd`.

## Предварительные условия

- Bash 5.1+, `uv>=0.13.1`, Python 3.13.16 (`backend/.python-version` и
  security minimum в `backend/pyproject.toml`). Системные установки не выполняются
  скриптами; старый uv может не знать этот Python release.
- Node/npm в диапазонах `frontend/package.json`: Node `>=22.23.3 <23`,
  npm `>=10.9.9 <11`; установки фиксирует `package-lock.json`.
- Для launcher: `setsid`, `ss`, `mktemp`, `rm`, `sleep`, `dirname`.
  Для synthetic tests дополнительно нужны `timeout`, `ps`, `env` с
  `--default-signal`, `cp`, `mv`, `mkdir`, `ln`, `chmod`, `touch`, `cat`.
- Для статических shell-проверок — ShellCheck. Отсутствующий инструмент —
  blocker, не успешная и не молча пропущенная проверка. Скрипты ничего не
  устанавливают системно и не требуют `sudo`.
- Свободные TCP-порты 8000 и 5173; существующие процессы launcher не завершает.
  `TMPDIR`, если задан, должен быть существующим writable/searchable каталогом.
  Допустимы абсолютные и относительные пути, в том числе с пробелами: перед
  сменой cwd скрипты разрешают путь относительно cwd вызывающего shell в
  абсолютный физический путь. Dev launcher создаёт внутри него отдельный
  приватный каталог и удаляет только его, не родительский каталог/соседние файлы.

## Setup из lock-файлов

```bash
(cd backend && uv sync --locked --python 3.13.16 --group dev)
(cd frontend && npm ci)
```

Backend использует собственный `backend/.venv`, frontend — собственный
`frontend/node_modules`. Не устанавливайте зависимости в Python Hermes или
системный Python; не обновляйте lock-файлы для обхода ошибки установки.

Необязательное явное окружение (локальный `.env` не коммитить):

```bash
cp .env.example .env
set -a
source .env
set +a
```

Не перезаписывайте существующий `.env`: в таком случае сначала прочитайте его
и вручную перенесите нужные настройки. Launcher и backend **не загружают `.env`
автоматически**. Без экспорта используется тот же default SQLite URL.
`LEXICONA_DATABASE_URL` — backend-only переменная; относительный SQLite path
разрешается из `backend/`. Не добавляйте секреты в `VITE_*` или frontend assets.

## Явная миграция

```bash
bash scripts/migrate.sh
```

Скрипт проверяет окружение, переходит в `backend/` и выполняет
`.venv/bin/alembic upgrade head` в foreground. Он возвращает код Alembic.
Миграции не выполняются при старте приложения. Команда изменяет выбранную БД:
для новой локальной разработки используйте отдельную disposable БД; не
направляйте её на единственную копию важных данных. Production backup/rollback
и deployment здесь не реализованы и не считаются проверенными.

## Dev: два процесса, только localhost

После setup и миграции:

```bash
bash scripts/dev.sh
```

Launcher запускает следующие реальные entrypoints:

```bash
(cd backend && .venv/bin/uvicorn lexicona.app:create_app --factory --host 127.0.0.1 --port 8000 --workers 1 --no-proxy-headers --no-access-log)
(cd frontend && npm run dev -- --host 127.0.0.1 --port 5173 --strictPort)
```

Это альтернативный ручной запуск в двух терминалах, не команды для запуска
поверх работающего launcher. `--workers 1` фиксирует один API worker независимо
от worker-переменных. `--no-proxy-headers` не позволяет переписывать ASGI peer
forwarded-заголовками до явного reviewed trusted ingress; `--no-access-log`
отключает raw URL access logging, но не создаёт application audit logger.
Launcher не очищает окружение вызывающего shell и не меняет системный proxy.
UI открывается на `http://127.0.0.1:5173`;
Vite проксирует `/api` в API на `127.0.0.1:8000` без отдельного browser origin.
Контракт API: `GET /api/v1/health/live` → HTTP 200 `{"status":"alive"}`;
`GET /api/v1/health/ready` → HTTP 200 `{"status":"ready"}` только при готовой
БД/схеме, иначе HTTP 503. Само сообщение launcher о запуске процессов **не
подтверждает readiness**: проверяйте реальный HTTP-ответ и UI отдельно.

`Ctrl+C` завершает оба дерева дочерних процессов и убирает приватный временный
каталог. `TERM`/`HUP` тоже обрабатываются; после ограниченного ожидания
неответившие дочерние процессы завершаются принудительно. При завершении одного
сервиса launcher останавливает второй и возвращает исходный ненулевой код;
неожиданный успешный выход сервиса превращается в exit 70. Launcher не является
watchdog/restart manager и не меняет firewall, DNS или внешние сетевые настройки.

## Проверки

Запускайте каждый блок с остановкой при первой ошибке; успешный build не
заменяет тесты, coverage, реальный HTTP smoke или независимое review.

Shell (из корня):

```bash
set -e
for script in scripts/dev.sh scripts/migrate.sh scripts/lib/common.sh scripts/tests/launchers.sh scripts/tests/fixtures/tool.sh; do
  bash -n "$script"
done
shellcheck -x -P SCRIPTDIR scripts/dev.sh scripts/migrate.sh scripts/lib/common.sh scripts/tests/launchers.sh scripts/tests/fixtures/tool.sh
bash scripts/tests/launchers.sh
```

`-P SCRIPTDIR` разрешает существующий source annotation относительно самого
скрипта. Synthetic suite проверяет missing prerequisites, ошибки preflight,
коллизии обоих портов, передачу exit code, сигналы, cleanup потомков (включая
игнорирующих TERM), сохранность постороннего PID, migration cwd/аргументы и
явный аргумент project root у `require_backend`, обязательный `--workers 1`
при унаследованных worker-переменных и реальную доступность relative TMPDIR с
пробелами из обоих child cwd с повторной проверкой own-only cleanup.
Fixtures — не приложение; PASS этого набора **не является app smoke**.

Backend (отдельный shell-блок из корня):

```bash
set -e
cd backend
mkdir -p .local-reports
.venv/bin/ruff check src tests migrations tools
.venv/bin/ruff format --check src tests migrations tools
.venv/bin/mypy --strict src tests migrations tools
.venv/bin/coverage run --concurrency=greenlet,thread -m pytest -q
.venv/bin/coverage json -o .local-reports/coverage.json
.venv/bin/coverage report
.venv/bin/python -m tools.coverage_gate .local-reports/coverage.json src migrations tools
```

Используется собственное установленное окружение и Coverage.py, **не**
отсутствующий pytest-cov (`pytest --cov` не используется). Порог и branch
measurement задаются `pyproject.toml`; отдельный gate независимо проверяет
исходники, реальные statements/arcs и отсутствие подавлений. Он требует
100% всего production inventory, включая новый и untracked код. Baseline B
нужно отдельно выполнить в неизменном checkout/окружении; порядок и параметры
`--baseline`/`--manifest` описаны в `backend/README.md`. Отчёт H не доказывает,
что тесты B запускались. Изменение runtime/toolchain явно фиксируется в review.
Для SQLAlchemy async continuations используется `--concurrency=greenlet,thread`;
baseline и candidate измеряются в том же режиме, без изменения порогов и исключений.

Frontend (отдельный shell-блок из корня):

```bash
set -e
cd frontend
npm run typecheck
npm run lint
npm run format:check
npm run test:coverage
npm run build
```

Это существующие package scripts, не вымышленные targets. Успешная установка
зависимостей и наличие команды не означают, что текущие исходники проходят её:
при сдаче сохраняйте фактические exit codes. Полная frontend-проверка также
требует baseline/source gate `npm run coverage:gate -- B ABS_BASELINE_FRONTEND coverage`:
`B` — полный immutable SHA, `ABS_BASELINE_FRONTEND` — отдельный checkout/окружение
своего B, а `coverage` — каталог его уже полученного original-source JSON.
Подготовка B, допустимый toolchain и реальные sabotage probes описаны в
`frontend/README.md`. Этот gate не устанавливает B и не переписывает его отчёты;
один native процент не доказывает отсутствие suppression или baseline regression.
Реальный совместный UI/API/SQLite
smoke выполняется после интеграции backend/frontend/launchers; synthetic tests,
unit mocks и production build его не заменяют. Docker/deployment, backup/restore,
нагрузочные проверки и физическое TTS не входят в этот launcher-срез.
