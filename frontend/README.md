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
- Coverage: V8, все `src/**/*.{ts,tsx}`, включая не импортированные тестами файлы и настоящий `main.tsx`; type-only `.d.ts` не исполняются. Per-file lines/branches/functions/statements — 100%. Отчёты в `coverage/` (не Git).
- `build` запускает strict typecheck и создаёт `dist/` (не Git).
- Unit/component tests используют jsdom и контролируемый fetch, **не доказывают реальное frontend → API → SQLite соединение**, browser layout или физическую доступность устройства.
- Реальный Chromium → Vite → API → одноразовая SQLite/WAL и fault-regressions fixture: `npm run test:e2e`. Сначала установите backend окружение и Chromium, освободите порты 8000/5173; точные команды, isolation/cleanup и ограничения — в [docs/testing.md](../docs/testing.md). Harness сам запускает два собственных сервиса; отдельный backend или `scripts/dev.sh` для E2E запускать не нужно.

## UI и данные

Dictionary-first shell: 320px/mobile, tablet и desktop; семантические landmarks, skip link, видимый keyboard focus, 44px controls. Цвета находятся только в semantic tokens `src/theme.css`; CSS Modules в `src/App.module.css`. Dark graphite/navy + gold/amber + warm white — default; light/system выбираются в «Тема», system реагирует на изменения ОС. Анимаций нет. Выбор темы хранится только в памяти и сбрасывается при reload.

Health-query публичный, только in-memory, `gcTime: 0`, без автоматических retry; fetch `cache: 'no-store'`, same-origin credentials, deadline/cancellation. Нет service worker, Cache Storage, IndexedDB, localStorage, persisted Query, auth tokens или приватного словаря. Обработка поздних ответов разных аккаунтов остаётся обязательной частью будущего auth-среза, а не заявленной возможностью foundation.

## Совместимость тестовых типов

В исходном наборе `@testing-library/jest-dom@7.0.1` и `vitest@5.0.5` runtime tests проходили, но `tsc` воспроизводимо выдавал TS2688/TS2428. Installed primary metadata/types показали две причины:

1. `types: ["@testing-library/jest-dom"]` загружал default `types/index.d.ts` → `jest.d.ts`, требуя отсутствующие Jest definitions, хотя runner — Vitest.
2. `types/vitest.d.ts` расширял `Assertion<T = any>`, тогда как installed Vitest декларировал другие generic parameters; peer range `vitest >=0.32` сам по себе совместимость типов не гарантировал.

Удалена только необязательная jest-dom зависимость и её augmentation. Существующие девять тестов сохранены с обычными DOM assertions (`getAttribute`, `hasAttribute`, `textContent`, null checks), добавлены проверки foundation. `skipLibCheck` остаётся **false**; подавления ошибок и патчи node_modules не используются.
