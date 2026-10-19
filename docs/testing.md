# Проверки development foundation

Все команды выполняются из корня checkout, если не указан другой каталог.
Нужны Linux, локальные backend/frontend окружения из `docs/development.md`.
Это не подтверждение готовности полного MVP или production deployment.

## Настоящий браузер → API → SQLite

Playwright Test зафиксирован в `frontend/package-lock.json`. После `npm ci`
браузер устанавливается отдельно (без системного `--with-deps`):

```bash
(cd frontend && ./node_modules/.bin/playwright install chromium)
(cd frontend && npm run test:e2e)
```

Playwright использует обычный пользовательский cache браузеров. При желании
можно задать собственный `PLAYWRIGHT_BROWSERS_PATH` при установке и запуске;
его значение должно совпадать. Скрытая `.lexicona/` и Hermes не требуются.
Если Chromium сообщает об отсутствующей системной библиотеке, это blocker:
тест не пропускается, установка системных пакетов согласуется отдельно.

Нужны свободные localhost-порты 8000 и 5173. Тест сначала проверяет их и не
подключается к уже работающему development server. Затем создаёт собственную
временную файловую БД, явно выполняет Alembic через `scripts/migrate.sh` и
непосредственно запускает **две собственные detached process groups**: настоящий
`uvicorn lexicona.app:create_app --factory --host 127.0.0.1 --port 8000 --workers 1 --no-proxy-headers --no-access-log`
и Vite через локальный Node, без промежуточного npm/shell launcher. Uvicorn не
переписывает socket peer forwarded-заголовками; raw URL access log отключён.
Проверка аргументов настоящего child process не заменяет будущий auth IP-bucket
regression или application-safe logging. Для обоих сервисов
явно передаются одноразовые `LEXICONA_DATABASE_URL` и `TMPDIR`; inherited DB URL
перекрывается, существующая БД не мигрируется. Migration/backend не source
корневую `.env`; стандартную dotenv-загрузку Vite это не отключает.

E2E **не запускает и не smoke-проверяет `scripts/dev.sh`**. Его runtime/failure
проверки выполняются отдельно; успешный E2E не является доказательством работы
этого development launcher.

Сценарии пользовательского пути проверяют:

- реальный Vite proxy → FastAPI → мигрированную файловую SQLite/WAL;
- точные health status/body и `Cache-Control: no-store`;
- готовность UI и отсутствие horizontal overflow при 320/768/1280px;
- keyboard skip-link/focus, темы и честный placeholder без демонстрационных слов;
- реальную неверную schema revision → ready503 при работающем live200;
- отображение отказа и успешный retry после восстановления schema revision.

`e2e/database-unavailable.e2e.ts` отдельно начинает работу с действительно
недоступной файловой БД: только внутри собственного temp-каталога fixture
заменяет родительский путь БД symlink на обычный файл. API стартует без
доступной БД, live остаётся 200, ready выдаёт безопасный 503/no-store/Retry-After,
а реальный UI объясняет отказ. Атомарная замена собственного symlink возвращает
ту же предварительно мигрированную БД без перезапуска API; повторная проверка UI
должна показать готовность. Чужие пути, серверы и данные не используются.
Это проверка реального filesystem failure, не mock и не только неверная revision.

Сетевые ответы не мокируются. Teardown сигналит только записанным при spawn
собственным service groups, независимо от жизнеспособности их leaders. После
SIGTERM даётся 1.5s на исчезновение групп и reaping прямых children, затем
SIGKILL и ещё до 1.5s; hard fallback/ранний выход сервиса остаются **ошибкой**,
не превращаются в success. Удаление своего каталога БД/TMPDIR и проверка портов
идут в `finally`, в том числе после ошибки/тайм-аута остановки или failed setup.
Порты используются только для проверки, не для поиска целей kill; чужие
процессы не завершаются. Проверка через `ss` имеет отдельный deadline 3s.

`e2e/cleanup.e2e.ts` отдельно проверяет нормальную остановку, SIGSTOP собственных
leaders и целых групп, раннюю SIGKILL-смерть API/Vite leader (включая оставшееся
Vite subtree). Каждый сценарий использует настоящие сервисы/мигрированную БД,
проверяет rejection при fault, bounded teardown, отсутствие записанных
PIDs/groups, обоих listeners и собственных temp dirs **до** test emergency
cleanup; несвязанный sentinel должен остаться жив. Только эти fixture-regressions:

```bash
(cd frontend && npm run test:e2e -- e2e/cleanup.e2e.ts)
```

Граница гарантии: cleanup выполняется живым Playwright worker. SIGKILL самого
runner/worker, power loss и системные отказы файловой системы этим fixture не
обрабатываются; отсутствие сервиса не объявляется успешным UI-тестом.
JSON-отчёт, screenshots и failure traces находятся в игнорируемом
`frontend/artifacts/`. Запуск с Chromium headless не доказывает физический touch,
работу Firefox/WebKit, TTS или полный WCAG/device audit.

## Статические проверки и unit/component tests

Команды backend/frontend/shell перечислены в `docs/development.md` и соответствующих
README. E2E не заменяет Ruff/strict mypy/TypeScript/ESLint/Prettier, unit tests,
100% executable lines и branches каждого production-файла или независимое review.
Строгая TypeScript-проверка включает Playwright config и E2E source; Vitest
изолированно запускает `tests/**/*.test.{ts,tsx}`, не Playwright tests.

## Дополнительные проверки перед публикацией

Проверенные версии инструментов: Gitleaks 8.30.1 и pip-audit 2.10.1. Они не входят
в runtime приложения: Gitleaks — отдельный executable из официального release с
проверкой checksum, pip-audit — отдельное изолированное Python-окружение. Не
устанавливайте их в Python Hermes. `npm audit` уже входит в npm.

При доступных в PATH инструментах:

```bash
gitleaks git --redact=100 --no-banner --log-opts=--all .
(cd frontend && npm audit)
```

Для Python сначала экспортируется именно lock без локального editable проекта:
`uv export --locked --no-emit-project --format requirements-txt --output-file PATH`
из `backend/`. Затем отдельный `pip-audit --require-hashes -r PATH` проверяет
все экспортированные зависимости, включая dev group по умолчанию. PATH должен
указывать на отдельный временный файл, не на исходники или пользовательские данные.

Не применять `audit fix --force`, `--ignore-vuln` или baseline-подавления ради
зелёного статуса. Advisory audit сообщает имена/версии зависимостей внешнему
сервису; словарь, ответы, auth tokens и credentials ему не передаются. Чистый
результат означает отсутствие известных инструменту findings на момент запуска,
а не доказательство полной безопасности. После изменений lock/source повторить
применимые проверки; опубликованная ветка сама по себе не означает ACCEPT.
