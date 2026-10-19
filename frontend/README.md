# Lexicona frontend foundation

React / TypeScript strict / Vite. Это основа приложения, **не готовый словарь или MVP**: доступны навигация, тема и реальная проверка готовности API. Вход и vocabulary API ещё не подключены; UI не показывает вымышленные сохранённые слова.

## Локальный запуск

Требуются Node **22.23.3** и npm **10.9.9** (проверяются `engines` / `.npmrc`). Из этой директории:

```sh
npm ci
npm run dev
```

Vite слушает только `127.0.0.1:5173`, strict port; `/api` проксируется на `http://127.0.0.1:8000`. Backend должен быть запущен отдельно по инструкции в корне проекта. Клиент запрашивает только `GET /api/v1/health/ready`: только HTTP 200 с `{"status":"ready"}` означает готовность API/БД, но не вход в аккаунт. Любой другой HTTP status (включая 201/202/203/206 и 503), некорректный ответ, ошибка сети или тайм-аут 8 секунд показывают недоступность и кнопку повторной проверки. `/health/live` не используется вместо readiness.

`npm run preview` показывает собранные публичные assets на `127.0.0.1:4173`. В текущем Vite **8.3.4** preview наследует `server.proxy`: `/api` также проксируется на `http://127.0.0.1:8000`. Открытие страницы автоматически вызывает readiness, поэтому preview **не изолирован от backend**. Другой `--port` меняет только порт preview, не адрес backend.

Для изолированного smoke запускайте preview в отдельном контейнере или сетевом namespace, где `127.0.0.1:8000` не относится к общему/рабочему backend. Без backend ожидается «Сервис недоступен», а не фиктивная готовность. Для реальной API-проверки в том же изолированном окружении нужен отдельно запущенный backend на `127.0.0.1:8000` с одноразовой тестовой SQLite DB. Не запускайте preview в общем сетевом окружении, если обращения к уже работающему backend не согласованы; mock/перехват fetch не является доказательством реальной API-интеграции.

Для готовности в production нужен same-origin reverse proxy `/api/v1` и SPA fallback на `index.html` для `/dictionary`, `/connection` и остальных клиентских маршрутов. Preview не заменяет production server.

## Проверки

```sh
npm run typecheck
npm run lint
npm run format:check
npm run test
npm run test:coverage
npm run build
```

- `npm run format` форматирует исходники и конфигурацию.
- Coverage provider остаётся закреплённым **V8**: `src/**/*.{ts,tsx}` и `tooling/**/*.{ts,tsx}`, включая не импортированные тестами файлы и настоящий `main.tsx`. Per-file lines/branches/functions/statements — **100%**, без округления. Отчёты `coverage/coverage-final.json` (original-source locations TS/TSX), `coverage-summary.json` и HTML не входят в Git.
- Strict typecheck включает `src`, `tooling`, `tests`, `e2e`, Vite/Playwright config; `skipLibCheck: false`. `npm run tooling:build` отдельно компилирует тот же strict tooling в `artifacts/coverage-tooling/` для Node CLI.
- `npm run test:coverage:sabotage` проверяет gate на настоящей V8 instrumentation: positive TSX probe, missing line/function/branch (в том числе implicit else), entirely unimported/untracked source, rename/deletion, скрытые ignore-комментарии, baseline regression и explicit type-only N/A. Временные отрицательные collector fixtures намеренно имеют thresholds 0, чтобы получить реальные JSON с missing units и проверить отказ gate; **production thresholds остаются 100**. Directive-like строки/regex/JSX text не считаются ignore-комментариями.
- `build` запускает strict typecheck и создаёт `dist/` (не Git).
- Unit/component tests используют jsdom и контролируемый fetch, **не доказывают реальное frontend → API → SQLite соединение**, browser layout или физическую доступность устройства.
- Реальный Chromium → Vite → API → одноразовая SQLite/WAL и fault-regressions fixture: `npm run test:e2e`. Сначала установите backend окружение и Chromium, освободите порты 8000/5173; точные команды, isolation/cleanup и ограничения — в [docs/testing.md](../docs/testing.md). Harness сам запускает два собственных сервиса; отдельный backend или `scripts/dev.sh` для E2E запускать не нужно.

## Manifest-aware baseline gate

`npm run coverage:gate -- B BASELINE_FRONTEND BASELINE_REPORT_DIR` принимает **ровно три аргумента**: полный 40-символьный SHA baseline, путь к отдельному frontend checkout этого commit и каталог его готового coverage report (относительно baseline frontend либо абсолютный). Candidate — текущая директория frontend. Gate сам повторно запускает candidate Vitest с V8, но **не создаёт baseline checkout, не устанавливает зависимости и не перезапускает baseline tests**.

Подготовьте B отдельно: checkout на согласованном SHA, чистый frontend, `npm ci` из его lock, тот же Node/npm и installed TypeScript/Vitest/coverage-v8. Сохраните полный успешный baseline test run и original-source JSON. Если версия B ещё не включает JSON reporter, разовый запуск из **baseline frontend**:

```sh
npm run test:coverage -- --coverage.reporter=json --coverage.reporter=json-summary --coverage.reportsDirectory=artifacts/baseline-coverage
```

Затем из **candidate frontend** (переменные задаются оператором, не приватными файлами проекта):

```sh
npm run coverage:gate -- "$B" "$BASELINE_FRONTEND" artifacts/baseline-coverage
```

Baseline остаётся read-only для gate. Сравниваются lock hash и установленные версии TypeScript/Vitest/V8; несовместимый toolchain требует отдельного объяснённого baseline, не автоматического PASS. Отчёты candidate: `artifacts/coverage-gate.json` и `artifacts/coverage-gate-native.log`. JSON содержит B/H commit, root, source hashes/applicability, tracked/untracked/rename manifest, changed-source, diff/coverage hashes и missing-unit/baseline-regression failures. Для незакоммиченного candidate H — его HEAD **плюс** manifests/diff hash; для review запускайте gate повторно после commit.

Inventory строится независимо от coverage imports по всему frontend для TS/TSX/JS/JSX/MJS/CJS (также MTS/CTS). Только корневые `node_modules`, `.git`, `dist`, `coverage`, `artifacts` — внешние/generated outputs; `tests/` и `e2e/` явно test-support, Vite/Playwright/ESLint configs — configuration. Types/пустые файлы без emitted executable units отмечаются `type-only: no emitted executable units`, не фиктивными 100%. Остальной runtime, включая новый каталог, обязан иметь source-location instrumentation: отсутствие в native include даёт FAIL, а не молчаливый пропуск. Source symlinks отклоняются. Каждый executable source сейчас проверяется строже changed-only: нулевые missing statements/functions/branch outcomes во всём файле; неизменённые и переименованные файлы дополнительно сравниваются с B. Реестр coverage exceptions пуст.

Gate проверяет schema/maps/outcome counts/границы source locations и настоящие ignore-комментарии, но не является защитой от умышленно подделанных отчётов или модифицированного test runner. Сохранность исходников в процессе instrumentation проверяется hashes; baseline JSON должен происходить из отдельно проверенного запуска B. Coverage не заменяет assertions, независимый review, real API E2E и physical TTS.

## UI и данные

Dictionary-first shell: 320px/mobile, tablet и desktop; семантические landmarks, skip link, видимый keyboard focus, 44px controls. Цвета находятся только в semantic tokens `src/theme.css`; CSS Modules в `src/App.module.css`. Dark graphite/navy + gold/amber + warm white — default; light/system выбираются в «Тема», system реагирует на изменения ОС. Анимаций нет. Выбор темы хранится только в памяти и сбрасывается при reload.

Health-query публичный, только in-memory, `gcTime: 0`, без автоматических retry; fetch `cache: 'no-store'`, same-origin credentials, deadline/cancellation. Нет service worker, Cache Storage, IndexedDB, localStorage, persisted Query, auth tokens или приватного словаря. Обработка поздних ответов разных аккаунтов остаётся обязательной частью будущего auth-среза, а не заявленной возможностью foundation.

## Совместимость тестовых типов

В исходном наборе `@testing-library/jest-dom@7.0.1` и `vitest@5.0.5` runtime tests проходили, но `tsc` воспроизводимо выдавал TS2688/TS2428. Installed primary metadata/types показали две причины:

1. `types: ["@testing-library/jest-dom"]` загружал default `types/index.d.ts` → `jest.d.ts`, требуя отсутствующие Jest definitions, хотя runner — Vitest.
2. `types/vitest.d.ts` расширял `Assertion<T = any>`, тогда как installed Vitest декларировал другие generic parameters; peer range `vitest >=0.32` сам по себе совместимость типов не гарантировал.

Удалена только необязательная jest-dom зависимость и её augmentation. Существующие девять тестов сохранены с обычными DOM assertions (`getAttribute`, `hasAttribute`, `textContent`, null checks), добавлены проверки foundation. `skipLibCheck` остаётся **false**; подавления ошибок и патчи node_modules не используются.
