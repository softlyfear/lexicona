# Lexicona account client — phase2A

React / TypeScript strict / Vite. Реальные `/login`, текущий аккаунт и logout через cookie API; `/dictionary` закрыт до me→csrf проверки и честно сообщает, что работа со словами ещё не реализована. `/connection` публичный. Это **не готовый словарь/MVP**: нет vocabulary CRUD, register/invite UI или функций безопасности аккаунта следующего среза.

## Локальный запуск

Требуются Node **22.23.3** и npm **10.9.9** (проверяются `engines` / `.npmrc`). Из этой директории:

```sh
npm ci
npm run dev
```

Vite слушает только `127.0.0.1:5173`, strict port; `/api` проксируется на `http://127.0.0.1:8000`. Backend должен быть запущен отдельно по инструкции в корне проекта. Клиент использует четыре фактических auth API (`GET /auth/me`, `GET /auth/csrf`, `POST /auth/login`, `POST /auth/logout` под `/api/v1`) и публичный `GET /api/v1/health/ready`. Только HTTP 200 с `{"status":"ready"}` означает готовность API/БД, но не вход в аккаунт. Любой другой HTTP status (включая 201/202/203/206 и 503), некорректный ответ, ошибка сети или тайм-аут 8 секунд показывают недоступность и кнопку повторной проверки. `/health/live` не используется вместо readiness.

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

Health-query публичный, отдельно от private QueryClient, только in-memory, `gcTime: 0`, без автоматических retry; fetch `cache: 'no-store'`, same-origin credentials, deadline/cancellation. Нет service worker, Cache Storage, IndexedDB, local/sessionStorage или persisted Query. Theme также остаётся в памяти.

## Account boundary и ограничения

- `src/auth/admission.ts`: immutable operation/revision/principal lease. Транспорт проверяет lease/stamp до/после body await/validation; callers повторяют admission **после собственного await**, до identity/cache/callback effects. Unabortable late A200/401 и ошибки старой операции отбрасываются до B; current mismatch скрывает/detaches generation и допускает одну свежую me→csrf revalidation, не бесконечный retry.
- Только designated unknown `me` устанавливает identity: `user.id` совпадает с canonical response stamp. Затем csrf обязан подтвердить тот же principal/authenticated flag. Login DTO provisional: private tree появляется только после same-user me и csrf. Error/early anonymous500 не означает confirmed logout. У auth fetch deadline15s, у readiness8s; server/transport failure не превращается в auth success.
- Logout синхронно скрывает private tree, abort/clear/detach query **и mutation** caches, credentials/drafts/CSRF; отправляет captured old principal, CSRF и JSON `{}`. Неизвестный серверный исход явно не подтверждён. Mutation retry и optimistic authenticated state отсутствуют.
- Новый private QueryClient на identity+revision, retry:false. API словаря здесь отсутствует; будущие private query/mutation callers обязаны использовать admission до queryFn return/callback, а не одну проверку в React effect. UUID principal — не session-generation/CAS и не полномочие владельца.
- Cookie transitions сериализованы в памяти вкладки и, где доступно, same-origin Web Lock. BroadcastChannel несёт **только строку** `auth-changed`, без IDs/tokens/DTO. При отсутствии BC нет мгновенного background-tab notification: focus/visibility/pageshow выполняют fail-closed recheck. HTTP-cookie CAS не обещается. Pagehide/hidden и возврат/notification синхронно убирают React DOM через `flushSync`, прежде чем браузер может заморозить snapshot; private content возвращается только после проверки. Speech adapter пока отсутствует, не выдумывается.
- RHF/Zod: password12–128 **Unicode scalar values**, без trim/NFC/truncation; malformed surrogates запрещены. Backend окончательный валидатор. Никаких default credentials, public bootstrap endpoint или auth storage. HTML/fetch используют no-referrer. Для JS JSON integer versions вне safe-integer range клиент fail-closed отказывает, не округляет и не выдумывает точность int64.

## Actual generated types

Из корня clone: `npm ci --prefix tooling/openapi`, затем `npm run generate --prefix tooling/openapi` / `npm run check --prefix tooling/openapi` (frontend install также обязателен). Pinned isolated CLI7.13/TS5.9 → canonical frontend Prettier → checked `src/shared/api/generated.ts`; frontend TS6/locks не меняются. Подробности — `tooling/openapi/README.md` в корне clone.

Generated TS **не полный schema validator**: реальные `$ref`-sibling enum/propertyNames widening компенсируются строгим Zod closed-response/operation/status/code/message/allowed-fields validation. Tests сверяют фактический phase2A snapshot и его registry, воспроизводят отказ widened types без casts и проверяют canonical drift. Type-only N/A конкретного generated output доказан AST и emit inventory, без ignore/exclude. Executable `tooling/generate.ts` входит в strict/native whole100.

## Real auth E2E

`npm run test:e2e` запускает прежние health/theme/320px/keyboard/DB-fault/own-only cleanup regressions и auth matrix. Fixture под `e2e/accounts.ts` создаёт **только в disposable migrated DB** два тестовых аккаунта с реальным Argon2; random passwords идут stdin/memory, не argv/env/output. Это test-only setup, не production API/CLI bootstrap acceptance. Backend source не модифицируется.

Auth tests: отдельные browser contexts для независимых accounts, shared-cookie tabs, reload/logout/back, pagehide/pageshow immediate-DOM boundary, held **реальные** HTTP200/401 (без замены payload), late cache/callback discard и actual expected-A+cookie/CSRF-B412/no-effect. Проверяются browser storage/SW отсутствие. Auth trace/video/screenshots выключены, password ввод не идёт в Playwright fill call logs; общие traces также выключены, поскольку даже public pages выполняют CSRF bootstrap.

Старые assertions о публичной dictionary placeholder намеренно заменены ожиданием `/login`: dictionary теперь защищён. Health exact DTO, responsive/keyboard/theme и пять cleanup-fault scenarios не удалены. Full invite/register A09 ждёт phase2B и отдельного UI handoff; physical devices/TTS/full WCAG/deployment этим срезом не подтверждаются.

## Совместимость тестовых типов

В исходном наборе `@testing-library/jest-dom@7.0.1` и `vitest@5.0.5` runtime tests проходили, но `tsc` воспроизводимо выдавал TS2688/TS2428. Installed primary metadata/types показали две причины:

1. `types: ["@testing-library/jest-dom"]` загружал default `types/index.d.ts` → `jest.d.ts`, требуя отсутствующие Jest definitions, хотя runner — Vitest.
2. `types/vitest.d.ts` расширял `Assertion<T = any>`, тогда как installed Vitest декларировал другие generic parameters; peer range `vitest >=0.32` сам по себе совместимость типов не гарантировал.

Удалена только необязательная jest-dom зависимость и её augmentation. Существующие девять тестов сохранены с обычными DOM assertions (`getAttribute`, `hasAttribute`, `textContent`, null checks), добавлены проверки foundation. `skipLibCheck` остаётся **false**; подавления ошибок и патчи node_modules не используются.
