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
запускает настоящий `scripts/dev.sh` с отдельным `LEXICONA_DATABASE_URL`.
Пользовательская `.env` не читается, существующая БД не мигрируется.

Два последовательных сценария проверяют:

- реальный Vite proxy → FastAPI → мигрированную файловую SQLite/WAL;
- точные health status/body и `Cache-Control: no-store`;
- готовность UI и отсутствие horizontal overflow при 320/768/1280px;
- keyboard skip-link/focus, темы и честный placeholder без демонстрационных слов;
- реальную неверную schema revision → ready503 при работающем live200;
- отображение отказа и успешный retry после восстановления schema revision.

Сетевые ответы не мокируются. В конце завершаются собственный launcher и его
сервисы, проверяется освобождение портов, удаляется только собственный временный
каталог БД. JSON-отчёт, screenshots и failure traces находятся в игнорируемом
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
