# Закрытые задачи

Упоминания Codex, Grok и каталогов `.codex/` и `.grok/` ниже — история закрытых
тикетов, не действующие настройки. Роли теперь в `.opencode/agents/`, настройки
в `opencode.jsonc`, общий протокол в этом каталоге.

## UNIQUE-002 — early duplicate warning (2026-11-14)

- Status: accepted; attempt 1; orchestrator: primary session; independent
  code-reviewer: Ship, no findings.
- Outcome/AC: translation lookup concurrently checks the owner's full dictionary
  for normalized exact word/phrase matches, including learned/excluded rows.
  The warning appears near the headword before translation results or Add,
  is associated with the input for accessibility, and clears on headword change.
- Stale results after change/cancel/unmount/session change/repeated lookup are
  ignored. Unchanged edited words, including legacy duplicates, remain editable.
  Failed early checks do not block manual entry; submit/server checks remain.
- Ownership: frontend-agent changed only WordForm and its regressions;
  primary session handled protocol, acceptance and Git. No API/schema/dependency
  changes. Sequence: implementation/tests → final gate → independent review.
- Verification: WordForm 41 passed; `make check` exit 0 (tooling 20 / backend
  463 / frontend 232), including format/lint/types/build. `git diff --check`
  passed. Reviewer reused evidence for identical code and checked the whole diff.
- Limitations: no browser visual check, deployment, server restart or database
  operations performed.

## SPEECH-005 — complete English Kokoro catalog (2026-11-14)

- Status: accepted; attempt 1; orchestrator root; independent review: Ship for the
  verified task-only snapshot. Backend owner updated the catalog and API tests.
- All 28 installed English voices are available: US 11 female/9 male and GB
  4 female/4 male. Existing IDs and Heart/Emma automatic defaults are preserved.
  No model, dependency, worker, frontend or other-language changes.
- Every voice produced a valid non-silent mono PCM16/24 kHz WAV through the
  authenticated local API. The local test server was restarted and settings opened.
- Final make fmt and make check passed on a temporary task-only snapshot of HEAD
  plus this task: tooling 38, backend 465, frontend 203; mypy/lint/build passed.
  All source files match HEAD except task-owned changes, verified byte for byte.
- The shared working tree's independent preference-sync work changed during
  execution. Its gate had 23 backend failures; its new preferences_revision column
  also prevented the old test database from logging in. No unrelated fixes or
  database migrations were made. The trial now runs from the verified snapshot
  with the existing project-local test database/account and model files.
- Listening preference remains subjective; all voices are exposed without a
  claim of equal quality. Existing unrelated changes remain excluded from Git.

## SPEECH-004 — optional local Kokoro trial (2026-11-14)

- Status: accepted; attempt 1; orchestrator root; independent code-reviewer: Ship.
- User chose the local computer and requested a test server/account. Added an
  opt-in Kokoro provider while preserving the Piper default and browser Russian.
- Backend owner implemented config/API dispatch, persistent isolated CPU worker,
  framing/cache/concurrency, timeout/crash cleanup and pinned SHA-256 downloads.
  Devops owner added the Python 3.13 lockfile, setup targets and README guidance.
- AC verified: four US/GB voices, all five speech rates, auth/CSRF/no-store,
  bounded WAV, cancelled requests, worker restart and no synthesis downloads.
- Final make check exit 0: tooling 38, backend 467, frontend 211; formatting,
  lint, mypy and production build passed. Independent targeted tests: 39 passed.
- Actual localhost API smoke produced mono PCM16/24 kHz WAV for all four voices,
  verified cache reuse and served the SPA. An isolated migrated database/account
  and six demonstration entries live under ignored `.local/kokoro-test`.
  Credentials are access-restricted and were not added to Git or printed.
- A 625-character sample succeeded; a 1680-character sample hit the 30-second
  timeout and the following request succeeded with a restarted worker. Subjective
  listening quality and physical-device audio remain unverified. Docker/VPS were
  not changed. Original unrelated preference-sync changes remain uncommitted.
- Reviewer P2 (runtime probe blocked the event loop) was fixed with to_thread
  and a regression proving the health endpoint responds during a slow probe.


## SPEECH-003 — выбор языка озвучки (2026-11-05)

- Статус: done; приёмка: ПРИНЯТО; попытка: 1.
- В настройках озвучки галочки «Английский» и «Русский», по умолчанию обе включены.
  Снятый язык не автоозвучивается и теряет кнопку произношения в словаре и тренировке.
  «Проверить» в настройках по-прежнему произносит образец. Старые настройки без новых
  полей остаются валидными.
- В том же срезе: кнопка «Установка» без описаний, ярлык Lexicona, компактный график
  статистики включая дни без ответов, кэш голоса Piper в процессе и пользовательский README.
- Gate всего среза: make check exit 0, tooling 23, pytest 383, vitest 173, сборка успешна.
  Независимое ревью: Ship. Живой браузер и контейнер :8000 не проверялись.

## SPEECH-002 — локальные CPU-голоса Piper (2026-11-04)

- Статус: done; приёмка root: ПРИНЯТО; попытка: 2. Выполнены backend/frontend/devops части.
- Piper1.8.0,10 реальных голосов: US Lessac/Kristin/Ryan/Joe,GB Alba/Jenny/Alan/Northern,
  RU Denis/Dmitri. По2м/2ж на каждый EN accent; root установил модели локально внеGit,
  pinned HF revision/SHA256 и оригинальные MODEL_CARD сохраняются. CLI make voices повторно
  использует проверенные файлы; runtime не делает сетевых загрузок и внешних TTS вызовов.
- GET voices/POST WAV защищены auth/CSRF/no-store; allowlist, text<=2000,rate1/.75,
  процесс без shell/GPU,30с/16MiB, sync semaphore до kill/wait, temp cleanup.
- Единый speech controller поддерживает auto/server/browser, preferences US/GB/RU по owner,
  отмену fetch/audio и revoke Blob URL. NotAllowedError сохраняет готовое аудио только в памяти;
  повторный tap вызывает play синхронно без второго synthesize. В Settings полные status/Stop,
  на остальных страницах только уведомления о требуемом действии.
- Первое независимое No-Ship P2: legacy en-AU терял browser voice при ready US/GB сервере.
  Исправлен auto fallback только к browser тому же locale; explicit server/missing saved server
  ID не подменяются. Reviewer лично повторил legacyAU/нетAU/explicitserver: Ship, новых дефектов нет.
- Финальный root make check exit0: tooling17/backend382/frontend167; Ruff/mypy/Prettier/
  oxlint/TypeScript/production build успешны. Реальный HTTP synthesis всех10голосов дал
  WAV22050Hz/no-store. Chromium Settings/serverGB/Alan: Audio ended,1fetch, prefs reload,
  390px без overflow/pageerror, прогресс не изменился. Скриншот просмотрен root.
- Devops make voices/compose config и CPU WAV в python3.14-slim PASS. После первого прерванного
  медленного build повтор конечного кода завершился успешно: lexicona-speech-local-check,
  image ae0b00eb6033. В итоговом образе без сети/портов проверены lexicona.tts, package manifest
  и реальный Ryan WAV32300байт с моделями read-only — PASS. Медленные слои не были ошибками кода.
- Локальный backend перезапущен с10голосами; backend/проксиhealth200, speech безauth401.
  Физические Android/iOS и внешний VPS не менялись/не проверялись.
- Runtime: Codex gpt-6.1-sol high (root/reviewer), gpt-6.1-terra high (исполнители/devops).

## TRAIN-009 / STATS-001 — продолжение занятий и первые ответы (2026-11-04)

- Статус: done; попытка: 1; приёмка root: ПРИНЯТО.
- Latest/by-id/finish, публичные state/results для восстановления Run/Matching, finished SQL
  guard и nullable SET NULL snapshots сохраняют занятие после reload/удаления слова.
  Latest — строго последнее, без fallback; удалённые modes/corrupt snapshots не продолжаются,
  но могут завершаться. Прежние API-сессии совместимы, уникальность active не заявляется.
- Immutable first-objective AnswerEvent unique(item_id) записывается вместе с CAS/прогрессом/
  SRS только для актуального слова; retries не меняют первую правильность. Legacy не бэкфиллятся.
- Статистика30д/год/all по московским дням, нули/график/таблица, счётчики и граница достоверной
  истории, без reset. Mobile навигация исправлена root на2x2 после реального overflow390px.
- Исполнители backend/frontend; root gate/миграция/smoke/приёмка. После квотной ошибки
  frontend-agent финальный CSS исправил root. Итоговый make check exit0:17/360/157,
  Ruff/mypy/Prettier/oxlint/TS/build успешны. Независимый reviewer прочитал весь diff: Ship.
- Root Chromium tempSQLite/Alembic+uvicorn+SPA PASS: wrong→reload→correct, partial matching
  reload, first attempts2/correct1, finish409, snapshots/history после удаления, одиночная точка
  графика и1280/390px без overflow/pageerror. Скриншоты просмотрены.
- Реальная локальная БД мигрирована на e65adf970121. Перед миграцией сохранена одноразовая
  согласованная локальная копия; все прежние row counts сохранены, FK/integrity checks OK.
  Журнал начинает достоверную историю с обновления. Внешний VPS не менялся.
- Runtime: Codex gpt-6.1-sol high (root/reviewer/architect), gpt-6.1-terra high (исполнители).

## TRANSLATE-002 — DeepSeek Flash Latest вместо Gemini (2026-11-03)

- Статус реализации: принята; попытка: 1. Внешняя live-проверка остаётся в TASKS.md:
  OpenRouter отклонил данный ключ с HTTP401 «User not found»; пользователь уведомлён.
- Gemini заменён OpenRouter с указанным пользователем router ~deepseek/deepseek-flash-latest,
  DeepL остаётся первым внешним переводчиком, local lookup/provenance прежние. Примеры,
  fallback-перевод и US IPA используют строгий chat/completions JSON/schema без reasoning;
  fixed HTTPS, no redirects, ответ64KiB, 60с LLM/15с DeepL, безопасные503/504.
- Root переименовал приватный OPEN_ROUTER в LEXICONA_OPENROUTER_API_KEY и выставил модель;
  старые Gemini env удалены, секрет не выводился и исключён из Git. Frontend показывает
  DeepSeek · OpenRouter и отдельные timeout-сообщения, сохраняет retry/late-response/примеры.
- Backend/frontend исполнили части; root make check exit0: tooling17/backend351/frontend146,
  формат/линтеры/mypy/TS/build успешны. Независимый reviewer прочитал полный diff, официальные
  contracts/router, проверил gitignore/diff: Ship для кода, без заявления о live-успехе.
- Runtime: Codex gpt-6.1-sol high (root/reviewer), gpt-6.1-terra high (исполнители).

### Live-проверка после обновления ключа пользователем

Root вызвал реальный ~deepseek/deepseek-flash-latest: EN/RU-пример для cat получен за1.41с,
перевод make yourself at home с альтернативами и US IPA — за0.59с. Оба запроса PASS;
секрет не выводился, ограничение401 устранено обновлением ключа.

## PWA-001 — установка веб-приложения на телефон и планшет (2026-11-03)

- Статус: done; попытка: 1; приёмка root: ПРИНЯТО.
- По новому запросу пользователя добавлены manifest с standalone, собственные PNG192/512,
  maskable512 и apple-touch180. Settings сохраняет browser install prompt до открытия
  страницы, вызывает его однократно и показывает инструкции Android Chrome/iOS Safari,
  необходимость HTTPS и интернета. Никаких service worker, кеширования данных или
  принудительного обновления активного занятия не добавлено.
- Frontend-agent выполнил frontend/** и 4 поведенческих теста установки. Backend-agent
  изолировал старый test_excluded_word_not_used_even_when_choice_has_enough_active от
  встроенного словаря: случайный builtin fox ошибочно ломал проверку исключённого личного
  fox. Production backend не менялся, проверка не отключена; targeted test/Ruff успешны.
- Первый make check: 340 passed / 1 failed на указанном тесте. Итоговый root make check
  после его стабилизации: exit 0, tooling17 / backend341 / frontend144, Ruff/mypy/Prettier/
  oxlint/TypeScript/production build успешны. Независимый code-reviewer прочитал весь diff
  и untracked assets, просмотрел PNG, подтвердил AC/безопасность/gate: Ship, дефектов нет.
- Root smoke: реальный Chromium с постоянным временным профилем, tempSQLite/Alembic head,
  uvicorn и production SPA; manifest parse и Page.getInstallabilityErrors без ошибок,
  размеры PNG, login/Settings390px, SW0/cache[], нет overflow/pageerror — PASS. Скриншот
  и maskable-иконка просмотрены. Физические Android/iOS и публичный HTTPS ещё не проверены.
- Root обновил scope/очередь согласно прямым исключениям пользователя. Остальные изменения
  (DeepSeek/OpenRouter, продолжение/статистика/TTS/веб-админка) ожидают ответов на уточнения;
  ключа OpenRouter в проектном .env/окружении нет. Architect подготовил read-only оценку
  snapshot/history/races; схема и пользовательские данные этим срезом не менялись.
- Runtime: Codex gpt-6.1-sol high (root/reviewer/architect), gpt-6.1-terra high (исполнители).

## UX-005 — учебные режимы и объединение тегов (2026-11-03)

- Статус: done; попытка: 1; приёмка root: ПРИНЯТО.
- По ручным замечаниям пользователя карточки EN→RU/RU→EN убраны из выбора режима и API
  новых занятий (422); сохранённые данные/legacy snapshots и их безопасность остаются.
- Matching формирует группы до восьми однозначных пар, при нехватке — доступный набор.
  Клиент определяет границы по длине snapshot options, поддерживая старые группы до четырёх.
  Проверка ответа/первая попытка/дельты/CAS/SRS/reveal/skip и отсутствие batch bonus сохранены.
- Несколько выбранных тегов объединяют слова по OR в словаре и тренировках; UI явно
  сообщает «любой выбранный». EXISTS/DISTINCT исключают дубли, owner/404/CSRF/no-store,
  поиск/сортировка/прогресс/исключение сохраняются. Схема не менялась.
- Владельцы: backend-agent — backend/src/tests, frontend-agent — frontend/src;
  root — требования/документация/протокол, gate, приёмка и Git.
- Root `make check`: exit 0, tooling 17 / backend 341 / frontend 140;
  Ruff/mypy/Prettier/oxlint/TypeScript/production build успешны. Независимый code-reviewer
  прочитал весь diff и подтвердил AC/gate/безопасность: Ship, дефектов нет; diff --check 0.
- Chromium smoke root на tempSQLite/Alembic head, реальных uvicorn и production SPA:
  cards нет в UI/API 422, теги расширяют 4→9 без дублей, matching 8+1 и 4 при нехватке,
  ошибка/исправление/сохранённый прогресс без batch bonus — PASS. Скриншоты 1280/390 px
  просмотрены, горизонтального overflow и pageerror нет. После временного DNS-сбоя PyPI
  smoke использовал установленный Playwright offline; URL-фильтр проверялся после
  асинхронного обновления checked. Финальный smoke полностью успешен.
- Локальные frontend/backend/прокси health отвечают 200; пользовательская БД не менялась
  проверками. Gemini timeout, другие режимы, настройки агентов, VPS/деплой вне scope.
- Runtime: Codex gpt-6.1-sol high (root/reviewer), Codex gpt-6.1-terra high (backend/frontend).

## TRAIN-008 — сопоставление английских слов и русских переводов (2026-11-03)

- Статус: done; попытка: 1; приёмка Kimi-оркестратора: ПРИНЯТО.
- Новый matching EN→RU использует существующие TrainingItem и общие choice AnswerIn/CHOICE/CAS/
  version/replay/SRS-пути. Группы до четырёх пар имеют уникальные EN/primary RU и непересекающиеся
  смыслы; ответ скрыт в server snapshot. Reveal/skip, owner/CSRF/no-store сохранены.
- UI показывает две колонки, исправление после ошибки без второго штрафа и последовательные
  группы. Использованные варианты блокируются только в текущей группе. Batch completion не
  вызывает API и не даёт дополнительного прогресса; reveal/skip учитываются отдельно.
- Финальный `make check`: exit 0; tooling 17, backend 336, frontend 138. Ruff, mypy,
  Prettier, oxlint, TypeScript и production build зелёные. Два предыдущих запуска остановились
  на известном unrelated случайном `test_new_options_and_invalid_replay[4]`; код не менялся.
- Независимый Kimi code-reviewer: Ship; дополнительно 84 backend training-тестов с исключением
  только указанного unrelated теста, 23 frontend-теста и `git diff --check` успешны.
- Live HTTP smoke на временной SQLite/Alembic head и реальном uvicorn: login/CSRF, пять слов,
  группы 4+1, ошибка -4, исправление delta=0, остальные ответы +4, без batch bonus — PASS.
- Runtime: Kimi Code k3.1-pro high. Физический браузер не проверялся; новый TTS, Codex и VPS
  остаются вне scope.

### Завершение Codex после Kimi (попытка 2, 2026-11-03)

- По прямому запросу пользователя завершён оставшийся незакоммиченным срез TRAIN-008;
  приёмка root: ПРИНЯТО. Реализация backend Kimi сохранена.
- Backend-agent исправил случайные предположения в тестах неоднозначных групп и choice replay;
  добавил проверки параллельных ответов/однократного SRS, фильтров/исключения, чужих answer/skip
  и CSRF. Целевая проверка: 44 passed, Ruff/mypy успешны.
- Frontend-agent согласовал знаменатель итогов с Run: assisted/skipped/unavailable считаются
  отдельно; skipped/unavailable не окрашиваются как правильные. Добавлены ожидание запроса
  и регрессии сетевого сбоя/повтора, блокировки запросов и клавиатуры: 4 matching-теста passed.
- Root — владелец gate: единый `make check` exit 0; tooling 17, backend 338, frontend 140;
  Ruff/mypy/Prettier/oxlint/TypeScript/production build успешны. Независимый code-reviewer
  прочитал весь diff, подтвердил AC, безопасность и gate; Ship, блокирующих замечаний нет.
- Root smoke: реальный headless Chromium, Alembic head на отдельной временной SQLite,
  uvicorn и production SPA; вход, пять слов через API, группы 4+1, ошибка/исправление,
  сохранённый прогресс без batch bonus — PASS. Скриншоты 1280/390 px просмотрены;
  overflow и pageerror нет. Физические устройства и production не проверялись.
- Runtime подтверждён по turn_context текущих rollout: Codex gpt-6.1-sol high (root/reviewer),
  Codex gpt-6.1-terra high (backend/frontend). Настройки Codex/Kimi, VPS и другие режимы вне scope.

## UX-004 — разнообразные примеры и точное название замены (2026-11-03)

- Статус: done; попытка: 1; приёмка Kimi-оркестратора: ПРИНЯТО.
- Gemini получает прежние EN-примеры отдельными строками в строгом JSON. Инструкция требует
  новую ситуацию, грамматическую конструкцию и лексику; для примеров temperature 0.9,
  переводы остаются детерминированными. Case-insensitive точный повтор не меняет поля.
- Append и replace передают историю примеров; кнопка явно называется «Заменить все примеры».
  Request validation, revision, auth, CSRF и no-store сохранены.
- Финальный `make check`: exit 0; tooling 17, backend 329, frontend 136. Ruff, mypy,
  Prettier, oxlint, TypeScript и production build зелёные.
- Независимый Kimi code-reviewer: Ship; дополнительно проверены 15 backend translation-тестов,
  36 frontend API/UI-тестов и `git diff --check`. Блокирующих замечаний нет.
- Реальный Gemini-запрос для `sleep` с прежними meeting/presentation-примерами вернул новый
  контекст про восстановление мышц после тренировок и его RU-перевод.
- Runtime: Kimi Code k3.1-pro high. Matching, новый TTS, Codex и VPS остаются вне scope.

## WORDS-005 — компактные подсказки и встроенные варианты (2026-11-02)

- Статус: done; попытка: 2; приёмка Kimi-оркестратора: ПРИНЯТО.
- WordForm автоматически выбирает IPA с US-признаками oʊ и ɹ/r/ɚ/ɝ либо первый доступный,
  не показывает IPA-кнопки/notices, выводит короткие RU-переводы без combining acute.
  Source refs, notices API/README, ручной ввод и защита от late responses сохранены.
- Choice в обоих направлениях смешивает личные кандидаты и до 120 случайных записей pinned
  dictionary через asyncio.to_thread. Builtins остаются скрытыми distractors, не становятся
  targets/Word/progress; недоступный индекс оставляет personal-only fallback.
- Первая ревью-итерация: No-Ship — stressed personal `це́ль` и unstressed built-in `цель`
  могли стать неоднозначными вариантами. Добавлен stress-insensitive `_choice_key` только для
  сравнения и регрессия в обоих направлениях; отображаемые личные данные не изменяются.
- Финальный `make check`: exit 0; tooling 17, backend 316, frontend 126. Ruff, mypy,
  Prettier, oxlint, TypeScript и production build зелёные.
- Повторный независимый Kimi code-reviewer: Ship; полный diff, 93 backend-теста,
  22 frontend-теста и `git diff --check` проверены, других дефектов не найдено.
- Live API/frontend smoke на запущенном приложении: login/CSRF, lookup hello с US IPA,
  choice из одного временного личного слова с шестью уникальными вариантами, отсутствие
  материализации builtins, удаление временного слова и SPA HTTP 200 — PASS.
- Runtime: Kimi Code k3.1-pro high. Fallback IPA не гарантирует диалект при отсутствии
  US-признаков. Перевод произвольных фраз и проверка орфографии обсуждены отдельно,
  но в этот тикет не входят и не реализованы.

## SRS-001 — занятия по расписанию и свободная практика (2026-11-02)

- Статус: done; попытка: 1; приёмка Kimi-оркестратора: ПРИНЯТО.
- Добавлены отдельное SRS-состояние `word_progress`, миграция с начальными строками,
  назначение scheduled/free у сессии и снимок progress_version у задания. Scheduled выбирает
  due и по желанию до 10 новых; free сохраняет прежний отбор и не меняет расписание.
- Реализованы все grade, интервалы 10 минут и 1/3/7/14/30/60 дней, сброс SRS после
  смысловой правки, owner/CSRF/no-store и отказ stale межсессионного ответа 409 PROGRESS_CHANGED.
  Terminal CAS, replay и отсутствие SRS-эффектов у assist/skip/unavailable/reveal сохранены.
- UI выбирает назначение занятия и включение новых слов, объясняет очередь и корректно
  обрабатывает пустую scheduled-очередь и конфликт версии без ложного успеха.
- Общий `make check`: exit 0; tooling 17, backend 313, frontend 123. Ruff, mypy,
  Prettier, oxlint, TypeScript и production build зелёные.
- Независимый Kimi code-reviewer: Ship; дополнительно прошли 127 training/SRS backend-тестов,
  13 size-тестов, 13 frontend-тестов и `git diff --check`. Блокирующих замечаний нет.
- Live HTTP smoke на временной SQLite с Alembic head, реальным uvicorn и собранным SPA:
  login/CSRF, создание слова, scheduled-ответ, replay, stale 409, пустая очередь и free
  без изменения SRS — PASS. Это HTTP-проверка, не ручной прогон на физических устройствах.
- Runtime: Kimi Code k3.1-pro high. Recovery сессий, Idempotency-Key, answer_events,
  статистика/история и следующие MVP-тикеты остаются вне scope. После тикета работа приостановлена.

## SETUP-006 — независимая конфигурация Kimi Code рядом с Codex (2026-11-02)

- Статус: done; попытка: 1; приёмка Kimi-оркестратора: ПРИНЯТО.
- Добавлены `.kimi-code/agents/` с основным orchestrator и шестью ролями, `make kimi`,
  отдельный PostToolUse formatter и пять tooling-регрессий. Модели ролей наследуются от
  основной Kimi-сессии; Codex CLI и model IDs не используются.
- README, Makefile и ignore-файлы описывают два независимых агента. Пользовательский Kimi
  config получил только formatter hook после timestamp backup и успешного `kimi doctor`.
- Живой каталог Kimi обнаружил все семь profiles. Общий `make check`: exit 0,
  tooling 17, backend 284, frontend 119; Ruff/mypy/Prettier/oxlint/tsc/build зелёные.
- Независимый Kimi code-reviewer: Ship. Лично проверил полный diff, frontmatter,
  dry-run команд и `make check-tooling` 17/17. Блокирующих замечаний нет.
- `.codex/config.toml`, `.codex/agents/**`, `.codex/hooks/**`, `scripts/codex*` и прежние
  tooling-тесты Codex не изменены. TASKS/PROJECT/archive остаются общим протоколом.
- Runtime: Kimi Code k3.1-pro high для оркестратора и reviewer. VPS/GitHub не изменялись.

## SETUP-001 — перенос на Codex и новый Git (2026-10-29)

- Статус: done; попытка: 1.
- Результат: единые правила AGENTS.md, шесть ролей Codex с наследованием модели,
  PROJECT/TASKS, переносимый hook apply_patch, Makefile и единые CI gates.
- Реализация и тестирование: оркестратор; независимое ревью: review_pipeline — Ship;
  независимая приёмка: accept_pipeline — ПРИНЯТО.
- make check: успешно; backend — 53 теста, frontend — 7, tooling — 5.
  Ruff, mypy, Prettier, oxlint, TypeScript и production build прошли.
- После финальной дельты make check-tooling повторно прошёл; вызов hook из backend/
  с реальным форматтером прошёл, backend gate повторно зелёный.
- Hook проверен на многофайловом patch, move, подкаталогах, legacy file_path,
  выходе за корень, symlink, generated-файлах и shell-тексте в payload.
- Старая .git целиком вынесена за проект в
  ../.git-backups/lexicona-20261029-125753/git; старые refs не импортируются.
- Новый main создаётся одним корневым коммитом с автором и коммиттером из git config.
  Финальное подтверждение количества коммитов, refs и clean status — после коммита.
- Origin сохранён. GitHub не изменён: на force push требуется явный ответ пользователя.
- Продуктовый код и приватные требования не изменены.

## SETUP-002 — модели ролей (2026-10-29)

- По запросу пользователя: architect и code-reviewer — gpt-6.1-sol high;
  backend/frontend/devops/tests — gpt-6.1-terra high.
- Версии сверены с https://learn.chatgpt.com/docs/models;
  настройки ролей — https://learn.chatgpt.com/docs/agent-configuration/subagents.
- Использованы точные актуальные ID, а не неподтверждённый алиас latest.
- Самопроверка оркестратором: TOML и соответствие всех шести назначений;
  make check прошёл: 65 тестов, статические проверки и сборка.
  Независимое ревью этой мелкой правки не проводилось.

## SETUP-003 — последние доступные Sol/Terra автоматически (2026-10-29)

- Статус: done; попытка: 1.
- scripts/codex сначала обновляет шесть ролей через scripts/codex_models.py,
  затем передаёт аргументы в Codex CLI, открывая корень проекта.
- make codex-models обновляет без запуска, make codex запускает wrapper.
- Каталог: официальный app-server model/list, handshake, пагинация, общий timeout.
  Выбор стабильной численно старшей версии своего семейства с поддержкой high;
  без downgrade, без правок неизвестных ролей, валидация всех изменений до записи.
- При недоступности каталога сохраняются текущие модели и запускается CLI.
  Файлы заменяются атомарно по одному, неизменённые не переписываются.
- Исполнитель auto_models: Codex gpt-6.1-terra high. Независимые reviewer и architect:
  Codex gpt-6.1-sol high, вердикты Ship и ПРИНЯТО.
- make check прошёл: backend 53, frontend 7; финальный check-tooling 12 тестов,
  включая timeout/reap дочернего процесса, handshake/пагинацию, offline wrapper,
  выбор версий, отсутствие downgrade и сохранение TOML. Ruff/types/build зелёные.
- Живые ./scripts/codex --version и make codex-models прошли без inference;
  текущие Sol6.1/Terra6.1 сохранены (новее в каталоге нет). bash -n и diff --check зелёные.
- Прямой запуск Desktop wrapper не вызывает; уже запущенные сессии не перезагружаются.
  В AGENTS.md точные ID читаются из TOML, чтобы текст инструкции не устаревал.
- GitHub не изменён: разрешение на force push по-прежнему не получено.

## TRAIN-001 — письменный ответ EN→RU и RU→EN (2026-10-29)

- Статус: done; попытка: 1; приёмка architect: ПРИНЯТО.
- Результат: input-сессии от одного личного слова, поле ввода и Enter,
  серверная обратная связь/допустимые ответы, error/retry без потери текста,
  блок повторной отправки и итог занятия. Choice API/UI сохранены.
- Ответы хранятся private snapshot; до ответа публично только id/prompt/пустые options.
  Сервер использует normalize и TYPED-дельты с frozen difficulty, clamp 0–100.
  CAS claim и запись прогресса в одной транзакции, content_version проверяется при записи;
  повторные/параллельные ответы не начисляют повторно, смысловая правка даёт delta 0.
- Миграция 0d31c9a7e210: snapshot/submitted_text, nullable correct_option;
  прежние choice-записи сохраняются, downgrade с typed items отказывается терять данные.
- Изменённые зоны: backend models/router/migration/tests, frontend api/training/tests,
  README одна строка готовой функциональности; слои и scope соблюдены.
- Реализация: backend-agent → frontend-agent → tests-agent, модели gpt-6.1-terra high.
  Независимый train_review gpt-6.1-sol high: Ship;
  architect gpt-6.1-sol high: ПРИНЯТО после чтения финального diff и тестов.
- Подтверждённый полный make check от tests-agent: exit 0, 12 tooling,
  64 backend, 10 frontend; Ruff/mypy/Prettier/oxlint/tsc/build зелёные.
  Reviewer лично выполнил 24 API-теста и diff --check, успешно.
  Architect повторно gate не запускал: подтверждённый результат относится к текущему diff.
- AC проверены по реализации и регрессиям: оба направления, дополнительные переводы,
  normalize, bounds, frozen settings, payload validation, snapshots после правок,
  owner-scoping/CSRF/no-store, deleted item, retry/parallel, UI и choice-регрессии.
- Ограничения: браузерная проверка на физических устройствах не выполнялась;
  SRS, новые учебные режимы и hints/skip вне scope.
- Коммит оркестратора: eb037f7; после коммита рабочее дерево было clean.
  Зависимость для TRAIN-002 закрыта.

## TRAIN-002 — карточки EN→RU и RU→EN (2026-10-29)

- Статус: done; попытка: 1; приёмка architect: ПРИНЯТО.
- Результат: карточки от одного личного слова, оборот через server reveal,
  самооценки again/hard/good/easy, delta/progress и итог числа оценённых карточек.
  Число правильных ответов/точность для самооценки не вычисляются.
- До reveal клиент не получает ожидаемые ответы. Reveal идемпотентен и не начисляет;
  grade до reveal отвергается. Только первая оценка закрывает item, CAS защищает от повторов
  и параллельных оценок. Snapshot, frozen difficulty, content_version и clamp сохранены.
- Миграция e14c8f510e43 добавляет revealed_at/grade; choice/input-записи сохраняются.
  Downgrade при наличии cards-сессий отказывается терять смысл данных.
- Проверены owner-scoping/404, CSRF, no-store, strict payload, все четыре grade,
  bounds, смысловые/косметические правки; objective is_correct у cards остаётся NULL.
- UI: reveal→grade→next→итог в обе стороны, блокировки pending/repeat,
  error/retry без ложного успеха. README дополнен строкой о готовом режиме.
- Подтверждённый полный make check tests-agent: exit 0, 12 tooling,
  84 backend, 13 frontend; Ruff/mypy/Prettier/oxlint/tsc/build зелёные.
- Независимый train_review: Ship; лично выполнены 20 card API-тестов и diff --check.
  Architect прочитал карточку, финальный diff, миграцию и регрессии; AC соблюдены,
  подтверждённый gate повторно не запускал.
- Оркестратор выполнил live HTTP smoke на временной SQLite с миграциями до head,
  реальном uvicorn и собранном SPA: login/CSRF/два пользователя, input/cards в обе
  стороны, до reveal 422, чужой item 404, replay, конечный прогресс 20; exit 0.
  Продуктовые данные не изменялись. Это HTTP-проверка, не ручной браузерный прогон.
- Вне scope остаются SRS, hints/skip и остальные учебные режимы.
  Коммит после приёмки выполняет оркестратор.

### Аудит конвейера на TRAIN-001 и TRAIN-002

- Каждый срез прошёл реальные стадии: architect (gpt-6.1-sol high) →
  backend-agent → frontend-agent → tests-agent (все gpt-6.1-terra high) →
  независимый code-reviewer → architect (оба gpt-6.1-sol high).
- Роли запускались через доступные проектные agent_type с назначенными моделями.
  TRAIN-001 закоммичен как eb037f7 до начала TRAIN-002; срезы не смешивались.
- Два независимых Ship и две архитектурные приёмки ПРИНЯТО; попытка 1 у каждого.
  Full gate подтверждён для каждого конечного diff, финальный HTTP smoke проверил
  совместную работу новых режимов с реальным сервером/БД и собранным приложением.
- Пайплайн выполнил реализацию и проверку, а не только создал карточки.
  Повторные полные gates без новых изменений не запускались.
- Открытых тикетов после этих двух нет. Force push по-прежнему ожидает явного разрешения;
  действий с GitHub/VPS в рамках этих срезов не выполнялось.

## TRAIN-003 — показать ответ и пропустить без штрафа (2026-10-29)

- Цель: пользователь может закончить трудное задание с помощью или пропустить его;
  эти действия сохраняются сервером, не меняют прогресс и отдельно видны в итоге занятия.
- Статус: done; попытка: 1; приёмка architect: ПРИНЯТО.
- Источник: утверждённый учебный контракт и разделы 11.3–11.4, 12.2, 17.6 приватного ТЗ.
- Решение о размере: только полное раскрытие ответа в choice/input, которое сразу закрывает
  попытку как assisted; частичные подсказки и продолжение ответа после раскрытия вне scope.
  Это законченный общий сценарий перед добавлением следующих учебных режимов.

### AC

1. В choice/input обоих направлений есть «Показать ответ». Сервер фиксирует assisted,
   возвращает снимок правильного ответа; delta=0 при любом начальном прогрессе/сложности.
   Это завершённая попытка с помощью, а не правильный или неправильный ответ.
2. Во всех трёх режимах и обоих направлениях доступно «Пропустить», в cards также после
   штатного reveal. Сервер закрывает item как skipped с delta=0, не записывает correct/grade.
   Пропуск сам по себе не раскрывает ожидаемый ответ.
3. Только первое терминальное действие answer / objective reveal / skip определяет
   результат. Повторные и параллельные действия, в том числе разных типов, возвращают
   сохранённый терминальный результат и больше не меняют прогресс. Карточное reveal
   остаётся нетерминальным; последующая grade работает как в TRAIN-002.
4. До answer/reveal ожидаемые ответы не утекают. Для input и choice помощь использует
   снимок задания, включая после правки слова; смысловая правка и content_version по-прежнему
   защищают обычное начисление. Удалённое/чужое задание — 404 без раскрытия данных.
5. Итог занятия отдельно считает самостоятельные верные/неверные, попытки с помощью,
   пропуски и оценки карточек. Помощь/пропуски не входят в знаменатель объективной точности;
   при отсутствии самостоятельных ответов не показывать 0% как точность.
6. UI ждёт подтверждения сервера, блокирует конкурирующие кнопки и клавиатурный ответ
   во время запроса и после закрытия item; показывает «С помощью»/«Пропущено», delta 0,
   кнопку «Далее». Ошибка сохраняет текущее задание/ввод, допускает retry без ложного успеха.
7. Для новых/расширенных endpoint проверены owner-scoping, CSRF и no-store; гонки разных
   терминальных действий покрыты API-регрессиями. Старые choice/input/cards сценарии проходят.
8. Alembic-миграция сохраняет существующие данные и помечает прежние отвеченные items
   как answered. Модели совпадают с миграциями. Полный make check зелёный для конечного diff.

### Контракт API и хранения

- Сохранить пути POST /api/training/items/{item_id}/answer и /reveal;
  добавить POST /api/training/items/{item_id}/skip без тела. CurrentAuth обязателен.
- У терминальных результатов добавить discriminator outcome: answered | assisted | skipped.
  Ответ answered сохраняет все прежние поля своего режима (choice/input/cards).
  Assisted: {outcome:"assisted", expected_answers:string[], delta:0, progress:int};
  для choice дополнительно correct_option:int. Skipped:
  {outcome:"skipped", delta:0, progress:int}, без правильного ответа.
- /answer и /skip возвращают фактический терминальный результат любой из трёх категорий:
  если другое действие уже выиграло, нельзя возвращать выдуманный успех запрошенного действия.
  Существующая строгая валидация payload и соответствия режиму сохраняется.
- /reveal для choice/input закрывает assisted и возвращает Assisted выше; при уже закрытом
  item возвращает его сохранённый терминальный результат. Choice expected_answers — один
  сохранённый options[correct_option], input — сохранённый expected_answers.
- /reveal для открытой cards возвращает {outcome:"revealed", expected_answers:string[]};
  обычное раскрытие не assisted и не даёт delta. Для закрытой cards вернуть фактический
  терминальный результат. Старые поля ответа карточного reveal сохраняются.
- Добавить nullable TrainingItem.outcome (String достаточной длины): NULL означает открытый
  item, остальные значения — терминальные. answered_at устанавливается для всех завершений.
  У assisted/skipped is_correct, chosen_option, submitted_text, grade остаются NULL,
  delta=0. revealed_at карточек сохраняет прежний смысл. Фактическая схема — через Alembic;
  downgrade не должен молча терять assisted/skipped.
- CAS по незавершённому item и изменение Word.progress — одна транзакция; выдавать
  канонический результат после refresh. Прогресс берётся текущий, как у существующего replay.
  Снимок правильного ответа и сохранённая difficulty обычных ответов остаются прежними.
- Не добавлять GET истории/восстановления сессии и новый общий event framework в этом срезе.

### Владельцы и цепочка

1. architect: эта карточка; при необходимости .codex/PROJECT.md; после Ship — приёмка.
2. backend-agent: backend/src/lexicona/models.py, routers/training.py, Alembic versions,
   целевые backend/tests/**. Реализовать API/миграцию, передать точные формы и результаты тестов.
3. frontend-agent: frontend/src/api.ts, pages/TrainingPage.tsx, при необходимости CSS module,
   frontend/src/**/*.test.ts(x). Работать по backend-контракту; цвета только через токены.
4. tests-agent: backend/tests/**, frontend/src/**/*.test.ts(x); проверить AC и дополнить
   содержательные регрессии, выполнить make check для конечного diff.
5. code-reviewer: весь diff + подтверждённый gate; Ship / No-Ship с воспроизведением дефектов.
6. architect: AC/контракты/проверки → ПРИНЯТО / НА ДОРАБОТКУ.
7. Оркестратор: README при необходимости, статусы, архив и коммит принятого среза.
   Только оркестратор меняет Git. Force push и VPS исключены.

### Проверки и ограничения

- Backend: оба направления помощи/пропуска; nonzero progress без изменений; snapshots,
  смысловые/косметические правки, карточное reveal→skip и reveal→grade, повтор и смешанные
  гонки answer/reveal/skip; чужой пользователь/CSRF/no-store; миграции и старые данные.
- Frontend: полный assisted/skip→next→summary в choice/input/cards, независимые категории,
  блокировки pending и клавиатуры, error/retry с сохранением текста и исходных сценариев.
- Команды: целевые pytest/vitest по изменению, затем make check; git diff --check.
- Вне scope: новые учебные режимы, SRS/расписание/история/статистика за пределами итога,
  восстановление сессии, частичные hints, повтор после помощи, TTS-переработка, деплой.
- Backend gate исполнителя: `make check-backend` exit 0; Ruff/mypy, 102 теста.
- Frontend gate исполнителя: `make check-frontend` exit 0; формат/lint/types/build, 24 теста.
- Оркестратор: live HTTP smoke exit 0 на временной SQLite с Alembic head, реальном uvicorn
  и собранном SPA. Два пользователя; все три режима в обоих направлениях; помощь/пропуск,
  карточное reveal/grade, повторы, CSRF/404 и смешанная параллельная гонка. Продуктовая БД
  не использовалась. Это HTTP-проверка, не ручной браузерный прогон.
- Общий `make check` tests-agent: exit 0; tooling 12, backend 112, frontend 26 тестов.
  Ruff/mypy/Prettier/oxlint/tsc и production build зелёные; `git diff --check` exit 0.
  Дополнительно проверены фактически сохранённый прогресс на всех пяти сложностях,
  смешанный итог занятия и retry пропуска с сохранением ввода. Продуктовых дефектов не найдено.
- Независимый code-reviewer: Ship; блокирующих дефектов нет, AC выполнены.
  Лично выполнены 28 API-регрессий, 12 frontend-регрессий и `git diff --check`, успешно.
  Общий gate принят как подтверждённый для конечного diff. Ручной браузерный прогон
  не выполнялся.
- Приёмка architect: ПРИНЯТО. Прочитаны конечный продуктовый diff, новая миграция
  3fae1c714a90 и новые API/UI-регрессии. AC 1–8 и контракты выполнены: терминальный CAS,
  канонический replay разных действий, снимки и owner-scoping сохранены; помощь/пропуск
  отделены от объективных ответов и самооценок. Приняты подтверждённые make check и
  независимый Ship для этого diff; повторный gate без изменений не запускался.
  Ограничение: ручной браузерный прогон отсутствует. Передано оркестратору для архива и коммита.

- Исполнители: backend/frontend/tests — Codex gpt-6.1-terra high;
  architect и независимый code-reviewer — Codex gpt-6.1-sol high.
- Принятый срез архивирован оркестратором; локальный коммит выполняется после приёмки.

## SETUP-004 — удалить прежнюю интеграцию Claude из проекта (2026-10-29)

- Цель: проект содержит только действующие настройки и инструкции Codex.
- Статус: done; попытка: 1; приёмка architect: ПРИНЯТО.
- Основание: прямой запрос пользователя удалить Claude из этого проекта.
- AC: удалить tracked CLAUDE.md и .claude/settings.json, .claude/hooks/format.sh;
  убрать связанные строки в .gitignore/.dockerignore, ссылку в AGENTS.md, зоны
  .claude/** и CLAUDE.md в .codex/agents/devops-agent.toml и название прежнего сервиса
  из docstring .codex/hooks/format.py. В активных настройках не остаётся ссылок
  на удалённые файлы; Codex hook и wrapper работают по прежним контрактам.
- Границы: только перечисленные файлы и протокол тикета. Не менять глобальные настройки
  пользователя, .local/, продуктовый код и Git-историю. Generic file_path в hook сохранить.
  Следующий продуктовый тикет планировать после закрытия cleanup.
- Исполнитель: оркестратор; отдельный агент реализации для этой небольшой правки не нужен.
  architect владеет карточкой; code-reviewer читает полный diff независимо после gate;
  architect принимает результат, оркестратор архивирует и коммитит.
- Проверки: поиск остаточных ссылок в tracked активных файлах, git diff --check,
  полный make check. Атрибуция/история не переписываются: чужих AI-авторов не найдено.
- Результаты: `make check` exit 0 — tooling 12, backend 112, frontend 26;
  Ruff/mypy/Prettier/oxlint/tsc/build зелёные. `git diff --check` exit 0;
  поиск в tracked активных файлах не находит остаточных ссылок, удалённых путей на диске нет.
- Новые глобальные Git-правила пользователя отражены в AGENTS.md: русские темы,
  один коммит на задачу, точная атрибуция с reasoning и проверенный force-with-lease.
  Метаданные модели и reasoning основной сессии недоступны; не подменяются настройками.
- Независимый code-reviewer: Ship. Проверены отсутствие активных ссылок, совпадение AST
  Codex hook, JSON/TOML, `bash -n scripts/codex` и `git diff --check`.
- Приёмка architect: ПРИНЯТО. Прочитан полный конечный diff; файлы прежней интеграции
  на диске отсутствуют, удалены только предусмотренные настройки и ссылки. Синхронизация
  Git-раздела AGENTS.md соответствует новым правилам пользователя. Поведение Codex hook,
  generic file_path, продуктовый код и приватные требования сохранены. Приняты независимый
  Ship и подтверждённый make check для текущего diff; повторный gate без изменений не
  запускался. Лично git diff --check — exit 0. Передано оркестратору для архива и коммита.

## TRAIN-004 — вписать английское выражение в личный пример (2026-10-29)

- Цель: cloze EN→EN по собственным примерам с серверной проверкой, помощью и пропуском.
- Статус: done; попытка: 2; приёмка architect: ПРИНЯТО.
- Источник: утверждённый учебный контракт — cloze(en_en), только личные однозначные
  примеры, TYPED-дельты, отсутствие данных не считается ошибкой знания.

### AC

1. UI предлагает «Слово в примере: EN → EN». Сервер начинает cloze-сессию от одного
   подходящего личного слова; неподходящие слова пропускает при подготовке, прогресс
   им не меняет. Если подходящих нет — 409 no_eligible_cloze_examples с понятной причиной
   и предложением добавить подходящий английский пример в словарь.
2. Подходит только непустой личный example_en с ровно одним вхождением целого headword
   или целой многословной фразы. Сервер заменяет весь найденный фрагмент на «____».
   Ни подстрока другого слова, ни словоформа/догадка не подходят; повторные вхождения,
   включая пересекающиеся у фраз, делают пример непригодным.
3. Сопоставление при подготовке консервативное: NFC, схлопывание whitespace и унификация
   типографских апострофов как в normalize; регистр игнорируется. Остальная пунктуация,
   отрицание и состав фразы значимы; морфология и fuzzy matching не применяются.
   Совпадение не может примыкать снаружи к букве, цифре, _, апострофу или дефису:
   cat не находится в category/cats/cat-like, can не находится в can't; cat в (Cat) подходит.
   При невозможности однозначно восстановить границы после нормализации пример исключается.
4. Публичное задание содержит только id/prompt/options, options=[]; prompt — английский
   пример с пропуском. До answer/reveal отсутствуют headword/expected_answers, исходный
   незамаскированный пример, RU-подсказка и example_ru. TTS, если кнопка показана,
   получает только замаскированный prompt. Текст вопроса и ожидаемый headword — snapshot.
5. Ввод и Enter проверяются сервером через существующий normalize против headword snapshot;
   результат — TextAnswerOut и TYPED-дельта frozen difficulty с clamp 0–100. Полный личный
   пример до 2000 символов не обрезается до прежней длины prompt 200 и не вызывает сбой.
6. «Показать ответ» закрывает assisted с delta 0, «Пропустить» — skipped с delta 0 без
   ответа. Только первое терминальное действие влияет на результат. Повторные/параллельные
   answer/reveal/skip возвращают канонический сохранённый outcome. Смысловая правка слова
   защищена content_version; изменение только примера не подменяет snapshot уже выданного
   вопроса и, как косметическая правка, не сбрасывает прогресс.
7. UI показывает задание и поле «Введите пропущенное выражение», серверную обратную связь,
   правильный ответ после answer/reveal, «Далее» и итог с раздельным учётом помощи/пропуска.
   До подтверждения успеха нет; pending блокирует конкурирующие действия, error/retry
   сохраняет ввод. Объясняется правило пригодности; при меньшем числе заданий виден
   фактический размер занятия, без имитации отсутствующих примеров.
8. en_en допустимо только для cloze; cloze с en_ru/ru_en и старые режимы с en_en дают 422.
   Owner-scoping/404, CSRF/no-store, миграция, старые режимы и их контракты сохранены.
   Конечный make check зелёный; есть содержательные unit/API/UI-регрессии новых правил.

### Контракт API и хранения

- POST /api/training/sessions: расширить mode значением cloze, direction значением en_en;
  валидировать пары режим/направление. Для cloze клиент явно отправляет оба поля.
  size/порядок выбора наименьшего прогресса прежние; выбирать только подходящие слова
  до size, каждое слово один раз. При частичной пригодности вернуть реальные items.
- SessionOut/ItemOut сохраняют форму. Для cloze prompt — полный замаскированный example_en,
  expected_answers=[headword] хранится приватно, correct_option=NULL/options=[].
  Не добавлять перевод или исходный пример в публичный payload.
- POST /api/training/items/{id}/answer для cloze принимает только строгий TextAnswerIn
  {text:string}, возвращает TextAnswerOut c outcome answered либо фактически сохранённый
  assisted/skipped. /reveal и /skip работают по контракту TRAIN-003, новых путей нет.
- Ошибка отсутствия подходящих примеров: HTTP 409 {detail:"no_eligible_cloze_examples"}.
  UI объясняет: «Добавьте английский пример, где слово или выражение встречается ровно
  один раз целиком». Для частичной пригодности достаточно пояснения критерия и реального
  числа сформированных заданий; отдельный endpoint доступности/список причин на слово не нужен.
- TrainingItem.prompt перевести из String(200) в Text через Alembic, без потери старых
  вопросов и результатов. Текст примера не обрезать. Downgrade не должен молча терять
  длинные prompt или оставлять cloze-сессии приложению, которое их не понимает.
- Чистую функцию подготовки cloze желательно вынести в backend/src/lexicona/cloze.py;
  не дублировать нормализацию ответа/дельты и терминальный CAS в отдельном endpoint.

### Владельцы, цепочка и проверки

1. architect: .codex/TASKS.md, при необходимости PROJECT.md; контракт и приёмка после Ship.
2. backend-agent: backend/src/lexicona/cloze.py, routers/training.py, models.py,
   backend/migrations/versions/** и целевые backend/tests/**; API, eligibility, миграция.
3. frontend-agent: frontend/src/api.ts, pages/TrainingPage.tsx, при необходимости CSS module
   и frontend/src/**/*.test.ts(x); UI по принятому backend-контракту, сеть только api.ts.
4. tests-agent: backend/tests/**, frontend/src/**/*.test.ts(x); проверить AC, добавить
   регрессии и выполнить make check для конечного diff.
5. code-reviewer: полный diff + подтверждённый gate, независимый Ship / No-Ship.
6. architect: AC/контракты/проверки → ПРИНЯТО / НА ДОРАБОТКУ; оркестратор архивирует
   и делает один коммит задачи. Git только у оркестратора, force push и VPS исключены.

- Unit: точное слово/фраза, NFC/регистр/пробелы/апострофы, literal пунктуация, границы,
  отсутствие/повтор/пересечение/словоформа/подстрока/пустой пример и длинный пример.
- API: хотя бы одно подходящее среди неподходящих; полностью непригодная и чужая область;
  no-answer leakage, strict body/пары режимов, correct/error/frozen difficulty/bounds,
  snapshot после косметической/смысловой правки, mixed races/replay, owner/CSRF/no-store;
  миграция с существующими данными. Старые сценарии продолжают проверяться.
- UI: start→text answer→feedback→next→summary; помощь/пропуск, unavailable reason,
  pending/error/retry, отсутствие RU/необработанного примера, TTS только masked prompt.
- Вне scope: другие новые режимы, альтернативные словоформы/морфология/генерация примеров,
  SRS/история/восстановление сессии, новый TTS и внешние API, деплой, переработка словаря.
- Backend gate исполнителя: `make check-backend` exit 0; Ruff/mypy, 146 тестов.
- Frontend gate исполнителя: `make check-frontend` exit 0; формат/lint/types/build, 31 тест.
- Оркестратор: live HTTP smoke exit 0 на временной SQLite с Alembic head, реальном uvicorn
  и собранном SPA. Проверены личный отбор/409, маскировка и приватный snapshot, длинный
  пример, TYPED-дельта, помощь/пропуск/replay, косметическая/смысловая правка, два владельца,
  CSRF/404, строгий payload/пары режимов и смешанная параллельная гонка.
  Продуктовая БД не использовалась; ручного браузерного прогона не было.
- Общий `make check` tests-agent: exit 0; tooling 12, backend 154, frontend 31 тест.
  Ruff/mypy/Prettier/oxlint/tsc и production build зелёные; `git diff --check` exit 0.
  Дополнены Unicode/границы, фраза с переносом строки, отбор наименьшего прогресса
  среди пригодных при ограниченном размере и snapshot после смены headword.
  Продуктовых дефектов не найдено.
- Ревью попытки 1: No-Ship, P2 в cloze.py:_boundary_character — U+2010/U+2011
  не считались дефисами, поэтому cat в cat‐like/cat‑like принимался как целое слово,
  а пример с таким составным словом и отдельным cat ошибочно отклонялся как повтор.
  Reviewer воспроизвёл дефект, выполнил 42 cloze API/unit-регрессии и diff --check.
  Возвращено backend-agent: исправить обе границы и добавить регрессии.
  После исправления требуются новый полный gate и независимое ревью. Приёмка: ожидается.
- Попытка 2: backend-agent исправил обе границы U+2010/U+2011; 48 целевых cloze-тестов
  и Ruff прошли. Tests-agent подтвердил finding и регрессии без дополнительных правок.
  Новый полный `make check` exit 0: tooling 12, backend 160, frontend 31;
  Ruff/mypy/Prettier/oxlint/tsc/build и `git diff --check` зелёные.
  Оркестратор повторил live HTTP smoke для нового diff с Unicode compound-only (409)
  и compound + отдельное слово (маскируется только отдельное): exit 0.
- Независимый reviewer попытки 2: Ship; P2 исправлен, новых замечаний нет, AC выполнены.
  Лично выполнены 48 cloze-тестов и `git diff --check`, успешно. Подтверждён финальный
  полный gate 12/160/31; ручной браузерный прогон не выполнялся.
- Приёмка architect: ПРИНЯТО. Прочитаны полный конечный diff, новые cloze.py, миграция
  9c7e4261ab38 и API/UI-регрессии. AC 1–8 и API/UI-контракты выполнены: whole matching
  с консервативными Unicode-границами, приватные snapshots, TYPED/outcome/CAS, пары
  режимов и Text prompts; finding U+2010/U+2011 закрыт регрессиями обеих границ.
  Приняты независимый Ship, подтверждённый новый make check 12/160/31 и live HTTP smoke
  для финального diff. Лично git diff --check — exit 0; gate без изменений не повторялся.
  Ограничение: ручного браузерного прогона нет. Передано оркестратору для архива и коммита.

- Фактические runtime участников: backend/frontend/tests — Codex gpt-6.1-terra high;
  architect и независимый code-reviewer — Codex gpt-6.1-sol high.
- Метаданные модели/reasoning основной сессии недоступны; не угадывались.
- Оркестратор архивировал принятый срез; один локальный коммит выполняется после приёмки.

## WORDS-001 — сортировка личного словаря

- Цель: пользователь выбирает удобный порядок слов, включая рост/убывание прогресса,
  не теряя поисковый запрос при смене порядка и возврате на страницу.
- Статус: done; попытка: 1; приёмка architect: ПРИНЯТО.
- Источник: новый запрос пользователя после ручной проверки и раздел 8.3 приватного ТЗ.

### AC и контракты

1. GET /api/words сохраняет формат списка и существующий q, добавляет sort из закрытого
   списка: created_desc (по умолчанию), created_asc, headword_asc, headword_desc,
   progress_asc, progress_desc. Имена колонок/SQL от клиента не принимаются; неизвестное
   значение sort даёт 422. Без sort порядок совпадает с прежним created_at DESC, id ASC.
2. По алфавиту сортировать по normalized_headword, по прогрессу — по реальному целому
   Word.progress; все равенства разрешать стабильным id ASC. Поиск накладывается до
   сортировки; owner_id и Cache-Control: no-store обязательны для каждого варианта.
   Никаких изменений слов, прогресса, content_version или порядка тренировок.
3. Над списком есть подписанный доступный select «Сортировка» с шестью понятными русскими
   вариантами: сначала новые/старые, слово А–Я/Я–А, прогресс по возрастанию/убыванию.
   Меняется реальный серверный запрос; порядок не пересчитывается только на клиенте.
4. Поиск и сортировка представлены URL-параметрами q/sort, инициализируются из URL
   и восстанавливаются при навигации назад/вперёд. Смена sort сохраняет q; смена q
   сохраняет sort. Пустой q и default sort можно опускать. Неизвестный sort в открытом
   URL безопасно трактуется UI как created_desc, не отправляется произвольно в API.
5. Все запросы через api.ts: listWords(q, sort='created_desc'); TanStack query key
   ['words', q, sort], поэтому ответы разных порядков не подменяют друг друга.
   Текущая invalidation ['words'] после create/edit/delete/training остаётся общей.
   Loading/error/empty состояния работают; если показывается предыдущая выдача во время
   загрузки, видно, что список обновляется. Редактор и сохранённые слова не теряются.
6. Содержательные API/UI-регрессии покрывают все порядки, равенства, поиск+sort,
   owner-scoping, неизвестный sort и восстановление URL. Конечный make check зелёный.

### Владельцы, цепочка и проверки

1. architect: эта карточка; после Ship — архитектурная приёмка.
2. backend-agent: backend/src/lexicona/routers/words.py, backend/tests/test_words.py
   или целевой test_words_sorting.py; allowlist/SQL ordering, API-регрессии.
3. frontend-agent: frontend/src/api.ts, pages/WordsPage.tsx, при необходимости CSS module
   и соответствующие frontend/src/**/*.test.ts(x); select, URL и query key.
4. tests-agent: backend/tests/** и frontend/src/**/*.test.ts(x); проверить AC и выполнить
   make check для конечного diff. Проверки tie-break должны задавать timestamps/progress,
   а не полагаться на случайное время создания или случайные UUID.
5. code-reviewer: весь diff и подтверждённый gate → Ship / No-Ship.
6. architect: AC/контракты/gate → ПРИНЯТО / НА ДОРАБОТКУ; оркестратор архивирует и коммитит.
- Команды: целевые pytest/vitest при реализации; финальный make check, git diff --check.
- Вне scope: новые фильтры/пагинация, теги, архив/изменение progress-policy, тренировки,
  внешние словари, профиль и TTS. Это первый срез большого запроса, не весь запрос.
- Проверки: `make check` tests-agent exit 0 — tooling 12, backend 167, frontend 39;
  Ruff/mypy/Prettier/oxlint/tsc/build и `git diff --check` зелёные.
  Проверены 6 порядков/tie/q/owner/422/no-store, URL/history/editor/previous-data;
  добавлена регрессия позднего ответа старой сортировки. Ревью/приёмка: ожидаются.
- Независимый reviewer: Ship, замечаний нет. Лично API 7, UI 7 passed и diff --check;
  подтверждён общий gate 12/167/39.
- Приёмка architect: ПРИНЯТО. Прочитаны весь продуктовый diff и новые API/UI-регрессии;
  AC 1–6 выполнены: серверный allowlist, стабильные tie-break, owner/search/no-store,
  URL/history и query key сохраняют выбранный порядок и редактор. Подтверждённый make check
  12/167/39 и независимый Ship относятся к конечному diff; gate повторно не запускался.
  Лично git diff --check — exit 0. Передано оркестратору для архива и коммита;
  остальная пользовательская очередь остаётся в работе.

- Runtime участников: Codex gpt-6.1-sol high и gpt-6.1-terra high.
- Метаданные основной сессии недоступны; локальный коммит выполняет оркестратор.

## WORDS-004 — локальные подсказки переводов и IPA в редакторе

Статус: done. Попытка: 1. План и приёмка — оркестратор.
Цель: при добавлении/редактировании слова предложить реальные RU-переводы и IPA,
сохранив ручной ввод, явный выбор и происхождение заимствованных данных.
Источник выбран ранее: FreeDict+WikDict eng-rus2025.11.23, CC-BY-SA3.0 Unported.
Прочитать .local/research/translation-source-selection.json и source-report.snapshot.md.

AC:
1. Реальный отдельный read-only SQLite индекс из закреплённого source archive,
   не из личной БД. CLI build принимает pinned archive или скачивает только фиксированный
   public URL, проверяет SHA256 до разбора, ограничивает download/archive/XML/rows/fields,
   не извлекает произвольные пути/ссылки, не исполняет код и не читает внешние DTD/entities.
   Atomic replace готового проверенного индекса; повреждение не уничтожает прежний.
2. Локальный POST /api/dictionary/lookup {headword:string1..200} с auth/CSRF/no-store;
   слово в body, без raw-word logs/внешних API/browser storage. Ответ source metadata+
   matches (entry_id,headword,part_of_speech,translations,transcriptions,match exact/normalized).
   Точное написание перед normalized fallback, далее исходный ordinal/sense; Apple/apple
   проверяются отдельно. Нет fuzzy/автогенерации/обещания популярности или US-IPA.
   Ответ ограничен; нет результата —200 matches[], индекс недоступен —503
   dictionary_unavailable, без утечки пути/SQL/персональных данных.
3. WordForm: явная кнопка запроса, loading/empty/error/retry, варианты сгруппированы
   по найденному слову/части речи. Перевод добавляется к ручным, нормализованные дубли
   не добавляются, максимум10. Выбор IPA явный и не приписывает вариантам акцент.
   До выбора/при сбое поля сохраняются; headword change/new query/account revision/
   unmount не дают позднему ответу менять новый draft. Manual save работает без индекса.
4. Данные CC-BY-SA отделены от MIT кода/личных ручных записей. Индекс сохраняет raw
   teiHeader/COPYING, pinned source/checksum/credits/URL/license и описание преобразований.
   Source notices доступны из UI (локальный endpoint notices + canonical/source links).
   Не перемаркировать3.0 на4.0 и не делать весь личный словарь ShareAlike по умолчанию.
5. Выбранные source values получают source_refs в Word: source_id, entry_id,
   field (translation|transcription), value. Это bounded owner-supplied provenance,
   не доказательство правильности/прав. Нужна additive Alembic JSON nullable column;
   WordOut отдаёт [], старый PUT без refs сохраняет surviving refs, [] снимает refs.
   Сохраняются только refs значений, оставшихся в соответствующих полях; без дублей.
   Источник/его license фиксированы, refs не принимают произвольные URL/license.
   Чужие refs/слова не читаются/не меняются; косметические refs не сбрасывают progress,
   смысловой перевод проходит существующее подтверждение reset. Будущий экспорт
   должен переносить refs и source notices; сам импорт/экспорт вне этого тикета.
6. Реальная сборка pinned индекса, smoke lookup/IPA/empty/Apple, UI explicit selection/
   drafts/race/account/duplicates/max10, owner/CSRF/no-store, migrations/FK и reset tests.
   Зафиксировать фактические размер/время индекса и lookup latency без обещания SLA.
   Один итоговый make check, независимый review, root acceptance/commit/manual refresh.

API contract: POST /dictionary/lookup body headword; ответ {source,matches} с limit20
entries и bounded translation/IPA lists. source содержит id/title/edition/license/license_url/
source_url/credits; fixed id freedict-wikdict-eng-rus-2025.11.23. GET /dictionary/notices
с auth/no-store отдаёт source manifest, raw COPYING/header/transformations без личных данных.
source_refs: [{source_id:fixed literal,entry_id:positive int,field:translation|transcription,
value:string}] <=20, без произвольных URI; API проверяет типы/соответствие текущим values.
Omitted PUT сохраняет surviving refs, источник не нужен для ручного сохранения/ref updates.
Frontend Word/WordInput допускают отсутствие source_refs для совместимости.
Runtime dictionary_path через Settings, default data/dictionaries/eng-rus-2025.11.23.sqlite3;
Docker получает индекс отдельно от /data пользовательской БД. Не коммитить compiled data.

Владельцы: backend-agent — backend/src/**, migrations/**, tests/**, backend metadata/lock
при необходимости. Сначала подтвердить bounded parser/response/ref contract root, затем
реализовать backend+CLI+tests. Frontend-agent — frontend/src/** после подтверждения API,
единственный владелец итогового gate после всех частей. Root — README/PROJECT/TASKS,
Dockerfile/Makefile/.env.example при необходимости, source/runtime/browser smoke и Git.
Чужое не отменять; общие файлы не менять параллельно; Git/деплой только root.
Без отдельного tests-agent. Конкретное архитектурное замечание решать с root по контракту.
Source cached /tmp/lexicona-eng-rus-2025.11.23.tar.xz, SHA256 подтверждён root:
f3dadcc29d7df6e77edb13b98a2ba2c3fac002852eddd8b557637f0b13d39c39 (3948540 bytes).
Raw TEI36394784 bytes, header62181 headwords; внешняя DTD есть в preamble, не загружать.
Root прочитал canonical CC3.0 legalcode и FreeDict downloads; licenses в source именно3.0.
Результат реализации: backend целевые20 passed; frontend целевые34 passed.
Итоговый gate после всех code/tests/CSS — make check exit 0, tooling12/backend284/
frontend119 (17 файлов), формат/lint/mypy/types/build прошли; diff --check чистый.
Прежний прогон поймал формат теста; после его исправления прошёл, затем browser нашёл
mobile notices overflow. CSS исправлен; первый gate после CSS прерван внешним SIGTERM
exit143 (причина не установлена), повтор полностью прошёл. Эти результаты не скрывать.
Root real pinned build: 62181 entry,8695808 bytes; CLI2.29с, peakRSS476852KiB (one-time).
500 локальных lookup вызовов: median0.182мс,p950.233мс,max0.386мс, без утверждения SLA/API.
Root Chrome156 browser — PASS: реальные RU/IPA, explicit append/manual draft/dups,
notices/COPYING, сохранение2 refs и reopen, empty/503/manual save, mobile390 без
overflow/pageerror. Ранние ошибки harness (textarea label/edit action name) исправлены,
они не были дефектами продукта. Root просмотрел mobile screenshot; CSS fix подтверждён.
Финальная Docker сборка ecf6d7376ecf — PASS. Изолированный smoke с --network none
и временным /data: uid10001 читает readonly индекс/IPA/notices, миграции доc83917f0d52a,
source_refs есть, uvicorn health и SPA/training — PASS; процесс/контейнер завершены.
Независимый review_next — Ship, полный diff20 файлов/мобильный screenshot проверены,
блокирующих замечаний нет; использован подтверждённый gate без повторного прогона.
Приёмка оркестратором: ПРИНЯТО, AC1–6 выполнены. Source/derived data остаютсяCC-BY-SA3.0,
refs/notices нужны будущему экспорту; не объявлять исходное исследование юридической
гарантией всех прав/качества. После архива/коммита и обновления manual app — пауза
по последнему указанию пользователя; новые тикеты и аудит полного MVP отложены.

- Runtime участников: Codex gpt-6.1-sol high и gpt-6.1-terra high.
- Метаданные основной сессии недоступны; локальный коммит выполняет оркестратор.

## TRAIN-005 — всегда шесть вариантов в новых choice-занятиях

Статус: done. Попытка: 1. План и приёмка — оркестратор.
Цель: выполнить прямой выбор пользователя «всегда 6 вариантов» без поломки ранее
сохранённых четырёхвариантных заданий, фильтров и начисления прогресса.

AC:
1. Каждое новое choice-задание EN→RU/RU→EN содержит ровно6 вариантов: один правильный
   и5 пригодных distractors, без повторов/совпадения нормализованных headword/meanings.
   Из чужих/исключённых слов варианты не создаются; targets учитывают start filters,
   distractors берутся из полного активного личного пула. Данные ответа скрыты до ответа.
2. Если шесть однозначных вариантов построить нельзя, target пропускается; при полном
   отсутствии пригодных заданий409 not_enough_words без частично записанной сессии.
   UI объясняет необходимость6 вариантов/активных слов с различными переводами.
3. API answer принимает строгий integer option>=0 и проверяет индекс по фактической
   длине сохранённых item.options, перед мутацией и replay. Legacy4 остаётся рабочим
   (индексы0..3), индексы4/5 для legacy4 —422; новые6 принимают0..5, индекс6 —422.
   Схема/миграции не меняются. Допустимый replay/гонки/CAS/CSRF/owner404 сохранены.
4. UI показывает все реальные options; клавиши1–6 работают для новых6, для legacy4
   клавиши5/6 не отправляют ответ. Повторное нажатие/состояния busy/result не удваивают
   ответы/начисления. Прочие режимы и speech cancellation не меняются.
5. Содержательные тесты: six unique/hidden answer в обоих направлениях, недостаточный/
   неоднозначный/исключённый пул, реальные индексы и legacy4+invalid/replay/concurrency;
   keyboard5/6 плюс legacy guard. Старые fixtures обновляются только где нужны6 слов
   для новых сессий, проверки безопасности и смысл тестов не ослабляются.

Контракт: SessionOut прежний, у новых choice items options.length=6; вход AnswerIn
строгий неотрицательный integer, верхняя граница определяется owned snapshot.
First terminal action и progress rules прежние; отсутствующий/чужой item —404.
Владельцы: backend-agent — backend/src/lexicona/routers/training.py и backend/tests/**;
frontend-agent — frontend/src/** и нужные frontend tests; root — README/PROJECT/TASKS,
browser smoke и Git. Ты не один, чужие изменения не отменять. Только непересекающиеся
файлы можно менять параллельно. Ни один исполнитель не делает Git/деплой.
Владелец итогового gate: frontend-agent после готовности backend (один make check).
Backend/frontend выполняют целевые проверки, затем независимый code-reviewer и root
приёмка/архив/коммит/обновление manual app; после этого открыть WORDS-004.
Без отдельного architect/tests-agent: архитектурная смена и новый API не требуются.
Результат: backend целевые145 training tests passed, frontend целевые5 passed;
единый финальный make check владельцем frontend — exit 0: tooling12/backend277/
frontend112 (16 файлов), формат/lint/mypy/types/build прошли; diff --check чистый.
Root browser smoke Chrome156.0.8078.4 — PASS: оба направления ровно6 вариантов,
keyboard5/6 и запрет повторного ответа, нажатие6-й кнопки,5 active→409 с понятной
ошибкой; mobile390 без overflow/pageerror. Мобильный скриншот просмотрен.
Независимый review_next: Ship, полный diff13 файлов проверен, блокеров нет.
Приёмка оркестратором: ПРИНЯТО, AC1–5 выполнены; gate не повторялся. После архива/
коммита и обновления manual app следующий тикет WORDS-004.

- Runtime участников: Codex gpt-6.1-sol high и gpt-6.1-terra high.
- Метаданные основной сессии недоступны; локальный коммит выполняет оркестратор.

## UI-001 — навигация в словарь и упрощение подготовки занятия

Статус: done. Попытка: 1. План и приёмка — оркестратор.
Основание: пять прямых замечаний пользователя со скриншотами 2026-10-31.
Этот запрос выполняется отдельно; остальная продуктовая очередь остаётся на паузе.

AC:
1. Lexicona в шапке — доступная ссылка на главную страницу со словами (/).
2. На страницах слов и текущей тренировки нет отдельной кнопки «Остановить речь»
   и статуса воспроизведения. Ручные кнопки слова/переводов и автоозвучка сохранены;
   отмена при навигации/редакторе/ответе/скрытии/выходе продолжает работать.
   В настройках голоса кнопка остановки и статус остаются возле теста звучания.
3. Свой размер занятия — положительное целое без продуктового максимума 500,
   включая запрос 501 и больше; фактическое число ограничено пригодным личным пулом.
   API сохраняет строгий integer, size="all", default10, owner/CSRF/версии/отбор.
   Никакой генерации пустых items/циклов на requested size: работа по пригодным словам.
4. Около тегов короткая подсказка «Можно выбрать теги для занятия», ниже возле полей
   процентов — «Можно указать диапазон выученности». Убраны технические формулировки
   про точное представление чисел/AND/лимит20. Реальная валидация не ослабляется:
   включительные неотрицательные границы, верхняя не меньше нижней, прогресс >100.
5. Фраза «Вопросы — по фильтру; варианты ответа — из всего активного словаря» удалена;
   реальный отбор и смысл существующих режимов не меняются. Мобильная вёрстка работает.

Контракт: POST /training/sessions size strict int>=1 без le500 | literal "all";
frontend отправляет точный положительный JSON integer, прочие параметры прежние.
UI не содержит product cap500; некорректный ввод не запускает запрос.
Размер > пула возвращает весь пригодный пул без дублей и показывает реальное N/Y.

Владельцы: backend-agent — training.py/нужные backend tests; frontend-agent —
frontend/src/** и затронутые tests. Параллельны только эти непересекающиеся файлы.
Root — TASKS/PROJECT/README/private requirements, browser smoke и Git.
Владелец итогового gate: frontend-agent после подтверждения готовности backend.
Исполнители делают целевые проверки; один make check, затем независимый code-reviewer
и приёмка root. Architect/tests-agent не требуются. Без Git у исполнителей, чужое не отменять.
Вне scope: всегда6 вариантов, lookup, новая озвучка/схема/поставка и возобновление всей очереди.
Проверки: API strict types/501/больше пула/scoping, действующие UI/speech регрессии,
browser ссылка на словарь/отсутствие speech panel/размер501/короткий текст/mobile.
Результат: backend целевые 13 passed; frontend целевые 29 passed.
Единственный итоговый make check (frontend-agent после всех code/tests) — exit 0:
tooling12/backend269/frontend110, статические проверки и build прошли; diff --check чистый.
Root Chrome156.0.8078.4 browser smoke — PASS: brand home/cancel, отсутствие speech panel
в словаре/занятии при сохранении Settings controls, numeric501 и реальное3/501,
диапазон100..201/ошибка обратного диапазона, короткие подсказки, mobile390 без overflow/pageerror.
Независимый review_next: Ship, полный diff и мобильные скриншоты проверены.
Приёмка оркестратором: ПРИНЯТО, AC1–5 выполнены; полный gate не повторялся.
В настройках остались проверка голоса/stop/status, на страницах слов/занятия панель
снята по прямому запросу; speech cancellation сохранена. Остальная очередь на паузе.

- Runtime участников: Codex gpt-6.1-sol high и gpt-6.1-terra high.
- Метаданные основной сессии недоступны; локальный коммит выполняет оркестратор.

## SETUP-005 — убрать дубли проверок и обязательных исполнителей

Статус: done. Попытка: 1. План и приёмка — оркестратор.
Цель по прямому запросу пользователя: сократить лишние передачи между ролями и
повторные проверки, сохранив проверку типов, полный gate и независимое ревью кода.

AC:
1. Обычная цепочка: оркестратор (AC/план) → только нужный исполнитель с тестами →
   независимый code-reviewer → оркестратор (приёмка/коммит). Architect и tests-agent
   опциональны для конкретных вопросов/пробелов; повторной приёмки architect нет.
2. В карточке назначается один владелец итогового make check после всех правок кода
   и тестов; по умолчанию последний исполнитель. Остальные используют подтверждённый
   результат для того же кода. Целевые проверки в ходе реализации допустимы;
   обязательного полного прогона каждого исполнителя перед общим gate нет.
3. check-frontend не запускает tsc дважды: отдельный typecheck исключён, npm run build
   сохраняет tsc -b и Vite. Самостоятельный typecheck, Docker build и CI не сломаны.
4. AGENTS, README, инструкции ролей и активная очередь согласованы. Архив прошлых
   протоколов, модели/доступы, продуктовый код и продуктовая пауза не меняются.

Владельцы: root — TASKS/archive и Git; devops-agent — AGENTS.md, README.md, Makefile,
.codex/agents/*.toml. Ты не один в кодовой базе; чужие изменения не отменять.
Владелец gate: devops-agent, один make check после реализации; результат передать
независимому code-reviewer без повторного полного прогона ради формальности.
Проверки: make check; make -n check-frontend (один tsc через build); чтение diff
на согласованность и сохранение product pause. Отдельные тесты текстов конфигурации
не добавлять. После Ship root принимает, архивирует, коммитит и останавливается.
Результат: реализованы AC1–4; один make check владельцем devops-agent — exit 0,
tooling12/backend269/frontend110, формат/lint/mypy/проверка типов/build зелёные.
make -n check-frontend — format:check, lint, test, build; отдельный typecheck исключён,
build сохраняет tsc -b. Шесть TOML ролей прочитаны tomllib без ошибок; diff --check чистый.
Независимый review_next — Ship, прочитан весь diff; полный gate не повторялся.
Приёмка оркестратором: ПРИНЯТО. Команды, роли и документация согласованы;
продуктовые TRAIN-005/WORDS-004 остаются на паузе. Docker build отдельно не запускался,
Dockerfile/CI/зависимости и продуктовый код не менялись.

- Runtime участников: Codex gpt-6.1-sol high и gpt-6.1-terra high.
- Метаданные основной сессии недоступны; локальный коммит выполняет оркестратор.

## SPEECH-001 — голоса браузера и автоозвучка prompt

Статус: done (принят, ожидает root archive/commit). Попытка: 2.
Architect: gpt-6.1-sol, reasoning high.
Цель: выбирать EN-акцент/EN и RU голоса, проверять звучание и управлять озвучкой;
автоматически читать публичный учебный prompt после «Начать»/«Далее».
Основание: spec §10/17.7/23.4, approved-training и новые прямые замечания пользователя.
Автоозвучка по умолчанию включена; EN-US — preference, не обещание наличия голоса.

### Наблюдаемые AC

1. В /settings доступны вариант английского (EN-US default, EN-GB и доступные EN-locales),
   отдельные EN/RU голоса из getVoices(), скорость «Обычная»1.0/«Медленная»0.75,
   переключатель автоозвучки default on. Выбор голоса показывает name/lang и
   локальный/сетевой сервис по localService, а также фактически используемый fallback.
   «Проверить EN»/«Проверить RU» читают фиксированные неперсональные примеры правильного
   языка, «Остановить» прекращает текущую/ожидающую речь. Смена preference сама не говорит.
2. Выбор сохраняется для этого browser+account и восстанавливается после reload;
   аккаунт B не наследует preferences/status/utterance A. Storage содержит только version,
   locale/voiceURI/rate/autoPrompt, без слов/prompts/паролей/cookie/CSRF/результатов.
   Блокировка/quota/corrupt storage даёт безопасные defaults/in-memory режим с объяснением,
   не ломает auth/словарь. UI прямо пишет, что эти настройки локальны этому браузеру.
3. Голоса могут появиться поздно: getVoices и voiceschanged обновляют список без reload.
   Первичное ожидание ограничено2с, затем явно «Голоса не найдены»; listener продолжает
   принимать последующие изменения списка, но просроченный запрос не оживает сам.
   Порядок выбора: сохранённый URI, если доступен и соответствует языку → exact locale
   → доступный голос того же primary language → понятное отсутствие голоса.
   Исчезнувший voiceURI не удаляется молча; fallback объясняется. English никогда
   не читается RU голосом и наоборот; неизвестный/пустой lang не подходит.
4. Единый adapter использует speechSynthesis/SpeechSynthesisUtterance, сохраняет ссылку
   на текущую utterance и управляет loading/speaking/end/error. Новый запрос сначала
   отменяет прежний, очередь не растёт; stop и cancel очищают pending wait/timers.
   Нет API/голоса, exception/not-allowed/error и watchdog объясняются, ручной retry доступен.
   Watchdog ограничен, но зависит от длины текста и скорости: длинный masked example
   не обрывается фиксированным коротким таймером. Старые events не меняют новый статус.
5. После успешного «Начать» один раз озвучивается первый item.prompt; после «Далее»
   (включая существующий keyboard shortcut) — только следующий item.prompt.
   EN→RU/cards/input/choice читают EN prompt; RU→EN — RU prompt; cloze — только серверный
   masked EN prompt. Не читать options, скрытый ответ/оборот, translations из иной
   записи или полученный reveal/answer; речь не вызывает backend reveal/answer/skip.
   Отключение auto сохраняет ручную озвучку; render/re-render/reveal/error/network retry
   сами не повторяют речь. Последнее «Далее» к итогам ничего не озвучивает.
6. Речь/ожидание отменяется при смене route, завершении/выходе из занятия, смене item,
   начале ответа/reveal/skip, скрытии документа, logout/401 и смене пользователя.
   Возврат во вкладку не возобновляет речь автоматически. Поздний ответ start, voiceschanged
   или event старой utterance после cancel/route/user switch не запускает старый prompt.
   React StrictMode не удваивает речь. TTS failure не изменяет прогресс/результат и
   не блокирует текстовый ответ/дальнейший переход; ошибка слышимости не ошибка знания.
7. Все ручные SpeakButton используют те же preferences/adapter/status и имеют доступное
   имя с языком. В словаре EN читает только headword; у каждого RU-перевода есть своя
   кнопка, общая RU-кнопка при наличии читает только основной перевод. Не включать IPA,
   теги/заметки. Ошибка/отсутствие API видны с объяснением, а не исчезнувшей функцией.
   Settings/training/words дают stop и доступный status/error без блокировки прочих действий,
   keyboard и узкий экран работают. Не обещать, что сетевой voice полностью локальный.
8. Реальные browser и mock проверки записаны отдельно от физической слышимости.
   При отсутствии системных голосов приложение честно показывает это состояние.
   Android/iOS/Firefox и качество речи отмечаются «не проверено», если нет реального
   устройства/браузера; автоматический speech fake не выдаётся за успешный физический звук.

### Контракты adapter, хранения и жизненного цикла

HTTP API, схема/миграции, backend и учебные snapshots остаются прежними.
Новых passive/listening режимов и начислений за TTS здесь нет.

- SpeechPreferences v1: {enLocale:"en-US" default, enVoiceURI:null|string,
  ruVoiceURI:null|string, rate:1|0.75 default1, autoPrompt:boolean defaulttrue}.
  ru locale фиксированный ru-RU. При смене EN accent очистить выбранный EN URI,
  чтобы explicit voice прежнего акцента не перекрывал новый выбор. Explicit EN голос
  может иметь другой EN locale; UI показывает реальный lang и не называет его US.
- localStorage key lexicona:speech:v1:<user.id>, данные проверяются по allowlist/types;
  чтение только текущего owner. Удаление чужих/общих ключей не требуется.
  Error storage не выходит из try/catch и не сохраняет текст в запасной store.
  Account-scoped controller сбрасывается/отвязывается на logout/switch; допустим
  лёгкий React provider/hook или subscription, без библиотеки/нового framework.
- Adapter обеспечивает voice list subscription + ready/loading/unavailable,
  speak(publicText, language:en|ru), cancel/stop и observation текущего status/error.
  Можно сохранить прежний speak(text, lang) wrapper или мигрировать все usages;
  один источник выбора voice и очереди обязателен. Language match по primary subtag,
  case-insensitive (en-* / ru-*), URI ищется только среди допустимого языка.
  Fallback exact locale → default того же языка → первый того же языка;
  системный произвольный голос без подходящего языка не используется.
- Voices wait <=2000ms на запрос. Пустой список после timeout не запускает речь позднее;
  следующий явный retry создаёт новый запрос. Для ожидания/utterance generation token
  и account/route/item scope отменяют все отложенные продолжения.
- Длительность watchdog от вызова speak: например clamp(20с,
  15с + codePointLength(text)/(8*rate) секунд, 10мин). Для prompt до2000 символов
  при0.75 получается несколько минут, не20с. Подтвердить fake timers для длинного текста.
  start/end/error/throw/watchdog завершают соответствующий запрос ровно один раз;
  intentional cancel — спокойный статус, timeout/error — объяснение + manual retry.
- Авто разрешено только цепочкой принятого user gesture «Начать»/«Далее» текущей сессии,
  без общего autoplay effect на render. Start требует async API: браузер может отказать
  после потери transient activation; показать отказ и ручную кнопку, не применять silent
  priming/обход, не обещать гарантированный autoplay. Scope проверяется и после API/wait.
  Для Next можно говорить следующий публичный item прямо в обработчике жеста.
- Синхронная отмена при forgetSession/logout до ожидания сетевого cleanup обязательна;
  auth revision/CAS/security flow не переписывать. App/route cleanup и visibilitychange
  дополняют её. Не делать dependency cycle session↔speech; speech не вызывает auth/API.
  Вся речь на странице проходит один controller, смена Settings preference cancels active.
- Озвучивание использует text только в памяти; не отправлять внешние fetch-запросы.
  Browser/OS может использовать удалённый движок: UI объясняет localService и отсутствие
  гарантии офлайн. Volume1/pitch1; никаких платных API/своего TTS backend.
  Фразы проверки: EN "Hello. This is an English voice test.", RU "Проверка русского голоса."

### Владельцы и границы файлов

- frontend-agent: frontend/src/speech.ts; небольшой speech hook/provider/status component
  в frontend/src при необходимости, components/ui.tsx (SpeakButton/status),
  pages/SettingsPage.tsx, TrainingPage.tsx, WordsPage.tsx, pages/pages.module.css;
  App.tsx/components/Layout.tsx для scope, session.ts только минимальная cancel integration.
  Сохранять password/difficulty flows. API/backend/зависимости менять не требуется.
- Тесты frontend-agent: speech.test.ts и необходимые tests Settings/Training/Words;
  tests-agent после реализации дополняет speech.test.ts, SettingsPage.test.tsx,
  TrainingSpeech.test.tsx (новый), session.test.tsx и существующие регрессии.
  Production находки возвращать владельцу, совместные файлы менять последовательно.
- code-reviewer проверяет весь diff, auth/scope/privacy и доказательства gate;
  architect меняет только TASKS/PROJECT/archive. Root ведёт browser smoke и README.
  Git/ветки только root, чужие правки не отменять. Backend/devops роли не нужны.

Вне scope: серверное хранение/синхронизация speech preferences, аудиофайлы/загрузка,
passive/listening/matching, новое SRS, изменение ответов/прогресса или количества choices.

### Цепочка и проверки

frontend-agent → tests-agent → code-reviewer → architect → root archive/commit.
- Adapter fake voices/events: initial empty→voiceschanged, 2с timeout→late update без
  stale playback, EN-US/EN-GB/explicit URI/fallback, исчезновение голоса/нет RU или EN,
  no API/getVoices throw/speak throw/not-allowed/end/error; cancel при новом запросе,
  ignore stale events, watchdog короткий и длинный при0.75, сохранённая utterance reference.
- Storage valid/corrupt/blocked, только preference fields, изоляция A/B и defaults auto on.
  Settings test sample EN/RU/rate/stop/localService, язык кнопки и отсутствие ложного success.
- Auto current prompt один раз после Start/Next, default on/off/manual retry, async отказ;
  RU→EN не читает EN hidden answer, cloze читает masked prompt; reveal/answer не создают
  авто и не вызываются TTS. Нет прогресса/штрафа/перехода при error/cancel.
- Route/hidden/finish/item change/forgetSession/logout/401/user switch и запоздалый start:
  cancel немедленно, прошлые scope не возвращаются; StrictMode/re-render без double speak.
  Существующие session/password tests сохраняются; words EN/каждый RU/общий primary.
- Один финальный make check, подтверждённые exit code/числа для конечного diff.
  Целевые команды: cd frontend && npm test -- src/speech.test.ts
  src/pages/TrainingSpeech.test.tsx src/pages/SettingsPage.test.tsx src/session.test.tsx
  (и фактические изменённые tests). Reviewer/architect успешный gate не повторяют без причины.
- Browser smoke на tempDB/SPA: настройки/тест/stop, авто Start/Next/public prompt,
  unavailable/no-voice UI, desktop/mobile без overflow/pageerror. Fake speech в browser
  подтверждает UI/events/тексты, отдельный native getVoices — только доступность API/голосов.
  Root baseline до реализации: Chromium156.0.8078.4 supported=true, voices=[] после3с;
  будущий native smoke должен честно проверить no-voice UI. Физический звук этим не проверен.
  Матрица: Desktop Chrome fake/native — записать результат; Desktop Firefox, Android Chrome,
  iOS Safari/PWA на физических устройствах — «не проверено», если недоступны.
  Это ограничение слышимости не блокирует независимую реализацию fallback/text flow.

Результаты попытки 1: frontend реализован; целевые speech tests 13 passed. Make check
tests-agent — exit 0: tooling12/backend269/frontend106 (15 файлов), статика и build зелёные;
git diff --check — exit 0. Root browser Chrome156.0.8078.4 fake — PASS: preferences/reload,
EN-GB/rate0.75/RU, auto Start/Next public prompt, cloze masked, auto off/manual retry,
stop/route cancel, отсутствие terminal API от ошибки TTS, mobile390 без overflow/pageerror.
Native getVoices=[] — корректные no-voice UI и retry; физическая слышимость не проверена.
Firefox/Android/iOS — не проверено. Ревью попытки 1: No-Ship, P2 — переход из списка
слов в изолированный редактор скрывает Stop, сохраняя текущую/ожидающую речь.
Воспроизведено reviewer в Chromium fake: active=true, cancel count не меняется.
Возврат frontend: cancelSpeech в startEditing без добавления controls в редактор;
tests-agent дополняет регрессию и повторяет gate для исправленного diff.
Попытка 2: cancelSpeech в общем startEditing отменяет active/pending для new/edit.
WordsSpeech.test.tsx — 4 passed; итоговый make check — exit 0, tooling12/backend269/
frontend110 (16 файлов), все статические проверки и build прошли; diff --check — exit 0.
Root повторный browser smoke с проверкой editor cancel и остальными сценариями — PASS.
Стенд: Ubuntu26.04.1, Chromium156.0.8078.4; native voices=[], fake подтверждает только
логику/UI. Независимый review_next попытки 2: Ship, блокирующих дефектов нет.
Приёмка architect: ПРИНЯТО. AC1–8 проверены по конечному diff и трём новым tests:
preferences/EN-US/языковой fallback/rate/localService, account storage, bounded wait/
watchdog/stale events, public Start/Next/RU/cloze, ручные RU/EN controls, cancel lifecycle.
Исправление первого No-Ship подтверждено cancelSpeech в startEditing и четырьмя
регрессиями new/edit × active/pending; изолированный new-редактор сохранён.
Подтверждён текущий gate попытки 2 — 12/269/110, exit 0; после него код/tests не менялись.
Просмотрены settings-mobile и native-no-voice screenshots, browser fake/native PASS
подтверждён root/reviewer. Личный git diff --check — exit 0; gate повторно не запускался.
Backend/API/учебный прогресс не менялись. Блокеров нет; Firefox/Android/iOS/физический
звук остаются «не проверено», mocks не доказывают слышимость или качество речи.
Handoff root: архивировать/коммитить SPEECH-001, обновить manual app; затем открыть
TRAIN-005 с совместимостью старых4-option snapshots. Git выполняет только root.

- Runtime участников: Codex gpt-6.1-sol high и gpt-6.1-terra high.
- Метаданные основной сессии недоступны; локальный коммит выполняет оркестратор.

## TRAIN-007 — все подходящие слова, теги, диапазон и случайный порядок

Статус: done (принят, ожидает root archive/commit). Попытка: 1.
Architect: gpt-6.1-sol, reasoning high.
Цель: запускать занятие по всем пригодным словам либо заданному числу, с AND-фильтром
личных тегов и включительным диапазоном процентов; выбирать/упорядочивать случайно.
Основание: новое прямое уточнение пользователя от 2026-10-30; оно заменяет least-known
default и прежнее ограничение только числового размера, сохраняя принятую policy прогресса.

### Наблюдаемые AC

1. Настройка размера имеет явный выбор «Все подходящие слова» либо число. Числовые
   presets и свободный integer 1..500/default10 сохранены; all не зависит от старого
   невалидного текста размера. Режим/направление работают для choice/input/cards/cloze.
   UI объясняет случайный порядок, убирает текст о наименьшем прогрессе.
2. На старте можно выбрать до 20 личных тегов по AND («все выбранные») и нижнюю/верхнюю
   границу прогресса включительно. Пустая граница не ограничивает соответствующую сторону;
   пустой список тегов не ограничивает теги. 0, 100, 101, 158 и выше допустимы;
   min=max отбирает точное значение. Отрицательные/дробные/нецелые и max<min объясняются
   до отправки; сервер проверяет независимо. Очистка фильтров возвращает весь активный пул.
3. Targets принадлежат owner, активны, удовлетворяют всем тегам/границам и mode eligibility.
   Порядок и выбор подмножества случайные среди всего пригодного пула, без сортировки
   по progress или приоритета первой страницы. В числовом режиме результат до N уникальных
   слов, all содержит каждое пригодное слово ровно один раз, включая пул >500.
   Нет скрытого среза до 500, автодублирования или исключения progress>=100.
4. Для choice targets строго из фильтра, а distractors из всего активного личного словаря,
   включая слова вне выбранных тегов/диапазона. Это явно объясняется в настройках choice;
   маленькая выбранная группа из 1–2 слов пригодна при достаточном общем активном пуле.
   Никаких чужих/исключённых/выдуманных вариантов; действующие правила неоднозначности,
   повторов и скрытого правильного ответа сохранены. Здесь ещё 4 options; переход на6
   отдельно в TRAIN-005. Cloze пропускает примеры, не прошедшие прежнюю mask eligibility.
5. Пустой/непригодный пул возвращает понятную ошибку, без пустой успешной сессии.
   UI сохраняет настройки и даёт изменить фильтры/перейти в словарь. Числовое сокращение
   объясняет «Доступно X из N», all показывает фактическое X как все подходящие, без
   сравнения X с500/фиктивного requestedSize. Pending блокирует настройки/двойной старт;
   ошибка tags-list явная и не блокирует запуск без тегов, приватный cache очищается
   прежним logout. В настройках доступны labels/keyboard и mobile без overflow.
6. Фильтры применяются только при старте: созданные items неизменны после снятия тега
   или изменения progress за пределы выбранного диапазона, если учебные версии прежние.
   Ответ, replay/CAS, смысловая правка, исключение/возврат и snapshot difficulty работают
   по ранее принятым правилам; не проверять текущие теги/диапазон повторно при ответе.
7. Чужой/неизвестный tag ID одинаково даёт404, чужие слова/теги не попадают в targets
   или options. POST sessions требует CSRF; неавторизованный401, no-store сохраняется.
   Старый POST с числовым size или без новых полей и ранее выданные items совместимы.

### Контракт API и алгоритма

POST /api/training/sessions, прежние mode/direction и ответ SessionOut неизменны:
{id, mode, direction, items:[{id,prompt,options}]}; правильных ответов в нём нет.

Дополнительный/расширенный request:
- size: строгий JSON integer1..500 либо точный string literal "all", default10.
  "3", "ALL", null, bool, float (включая3.0), 0/501 →422. "all" не ограничивается500.
  Пример: {mode:"input",direction:"en_ru",size:"all",tag_ids:["id1","id2"],
  progress_min:100,progress_max:158}.
- tag_ids: string[] default[], максимум20 элементов до дедупликации, ID длиной1..32;
  null/нестроковый/пустой/слишком длинный элемент →422. Повтор ID идемпотентен.
  Каждый уникальный ID проверять по owner до формирования сессии; чужой/неизвестный
  одинаково404 tag_not_found. Никаких tag names/client word IDs в этом endpoint.
- progress_min / progress_max: строгий JSON integer>=0 либо null/omitted (нет границы).
  При обеих границах max>=min, иначе422. Нового продуктового upper bound, в частности100,
  нет; не допускать переполнения SQL integer binding для больших границ: допустимы
  сравнения Python int с уже загруженными progress. UI не округляет непредставимое
  целое молча и показывает ошибку, если число нельзя передать точно.
- Пул distractors — все Word с owner_id auth.user.id и is_excluded=false; targets
  дополнительно AND tag_ids и включительный progress range. Фильтрация не должна
  размножать слова через join. Перемешать пригодные targets до числового отсечения.
  Если выборка содержит непригодные choice/cloze targets, они не занимают места:
  добрать до N из остальных либо вернуть весь пригодный остаток.
- При отсутствии совпавших targets из-за заданных тегов/границ:409 no_matching_words.
  При отсутствии пригодных choice вариантов прежний409 not_enough_words;
  cloze —409 no_eligible_cloze_examples. Без фильтров сохранить прежние409.
  Любая ошибка оставляет БД без частично созданной сессии/items. Item snapshots и
  difficulty создаются в одной транзакции; all не требует очередей/нового процесса.
- GET /api/tags и query key ['tags'] использовать повторно; настройки только в памяти
  Setup, никаких storage/нового URL-контракта для тренировки. Входные параметры не
  обязаны храниться в отдельной schema/config: материализованные items фиксируют отбор.
  Новая миграция/смена схемы для этого среза не требуется.
- Frontend api.startTraining расширить совместимым способом: размер number|'all',
  необязательный объект {tag_ids,progress_min,progress_max} после прежних аргументов;
  прежние вызовы без фильтров сохраняются. Fetch только api.ts.
  started/requestedSize сохраняет number|'all'; all отображает session.items.length.
  Choices UI объясняет: «Вопросы — по фильтру; варианты ответа — из всего активного словаря».
- Случайность — обычная серверная uniform shuffle/sample без security/anti-cheat обещаний.
  Полный all ограничен реальным личным словарём, без нового защитного cap под видом «все»;
  не добавлять paginated UI загрузку вместо полной сессии/не менять стек.
  При необходимости ускорить формирование/запись батчами внутри той же транзакции.

### Владельцы и границы

- backend-agent: backend/src/lexicona/routers/training.py и небольшой helper отбора при
  необходимости; backend/tests/test_training_filters.py (новый), test_training_size.py,
  test_training.py — обновить прежние ожидания least-known. Модели/миграции/прогресс
  и обработчики уже выданных items не менять без найденной конкретной необходимости.
- frontend-agent после контракта: frontend/src/api.ts, api.test.ts,
  pages/TrainingPage.tsx, pages/pages.module.css и TrainingSize/TrainingFilters tests.
  Только необходимые mock listTags в остальных training tests; не менять учебную механику.
- tests-agent после реализации: backend/tests/test_training_filters.py,
  test_training_size.py/test_training.py и frontend/src/pages/TrainingFilters.test.tsx,
  TrainingSize.test.tsx, api.test.ts; дополнительные регрессии по фактическим рискам.
  Production находки возвращать владельцам. README кратко обновляет root по результату.
- code-reviewer: весь diff/AC/доказательства; architect: PROJECT/TASKS/archive.
  Devops не нужен; чужие правки не отменять, Git/ветки только root.

Вне scope:6 options, новые учебные режимы/SRS, фильтры подборок/избранного,
сохранение настроек между reload, счётчик preview отдельным endpoint, новые зависимости.
Очередь voices/always6/lookup и аудит оставшегося согласованного MVP сохраняются.

### Цепочка и проверки

backend-agent → frontend-agent → tests-agent → code-reviewer → architect → root archive/commit.
- API validation matrix size/all/tag IDs/range (0,100,101,158,min=max,одна граница,
  оба отсутствуют), owner404 и CSRF401/403/no-store; range/token errors не создают items.
- AND2+range+excluded/owner смешанный пул; повтор tag IDs не дублирует targets.
  Choice1–2 filtered targets использует только active-own distractors вне фильтра;
  неоднозначность/исключение/чужой пул не обходятся. Cloze пропускает непригодное.
- Реальный пул501+ уникальных слов: all возвращает все без500 cap; числовой500 сохраняет
  лимит. Проверить все7 существующих mode/direction комбинаций, реальные Word IDs
  items без повторов и privacy полей; записать длительность самого тяжёлого прогона.
- Случайный порядок проверить детерминированным RNG substitute с известной перестановкой:
  среди неодинаковых progress правильный набор и порядок без сортировки least-known.
  Не использовать flaky утверждение «два случайных запуска обязательно различаются».
- После старта снять тег/изменить progress, ответить и replay: snapshot продолжает
  действовать; смысловая правка/исключение сохраняет прежние регрессии иCAS.
- UI all↔number/presets, диапазон/ошибки, tag filter/clear/error-list, pending/double submit,
  error keeps settings, фактический счётчик all и numeric-shortfall; удалить старый текст.
  Browser desktop/mobile с настоящим API на tempDB: all+range+AND, число, ошибка/clear,
  отсутствие overflow/pageerror. Недоступную проверку явно отметить.

Команды: cd backend && uv run --locked pytest tests/test_training_filters.py
tests/test_training_size.py tests/test_training.py; cd frontend && npm test --
src/pages/TrainingFilters.test.tsx src/pages/TrainingSize.test.tsx (и фактические api tests).
После финального кода/tests — один make check с exit code/числами и привязкой к diff.
Reviewer/architect используют подтверждённый gate, без повторного полного прогона.

Результаты: реализованы size all/число, AND теги, включительный диапазон и случайный отбор.
Подтверждён полный `make check` tests_next: exit 0, tooling 12 / backend 269 /
frontend 93; Ruff/format/mypy/Prettier/lint/typecheck/build и diff --check зелёные.
Дополнены матрица включительных границ/huge ints, отсутствие частичных сессий при
ошибках и UI all с невалидным size/range. Реальные 501 item во всех7комбинациях
проверены без500cap/дублей; отдельный backend-прогон занял0,59с тела теста.
Root настоящий Chromium156/tempSQLite/uvicorn/SPA: all поверх невалидного size,
личный тег+100..158 включительно, точный158, реальныеN/Y, skip→summary и mobile390
безoverflow/pageerror — PASS. Скриншоты /tmp/lexicona-training-filter-*.png.
Продуктовые файлы после gate не менялись; физические устройства не проверялись.
Независимый review_next: Ship, AC1–7 выполнены, подтверждённых дефектов нет. Прочитан
весь diff21файла; проверены uniform target selection, all>500, full active distractors,
owner/AND/range/huge ints, backwards compatibility и snapshot/CAS. Gate12/269/93 и
browser PASS подтверждены, скриншоты просмотрены; diff --check чистый.
Приёмка architect: ПРИНЯТО. AC1–7 сопоставлены с конечными production/test изменениями,
новыми файлами TrainingFilters, независимым Ship и подтверждённым gate 12/269/93.
Проверены strict validation и совместимый size, AND/owner, включительные границы/huge ints,
случайное подмножество до numeric limit с добором пригодных items, реальный all501 во всех
7 сочетаниях, full active-own distractors, отсутствие новых проверок filters при ответе,
privacy/CAS и UI all/ошибки/pending. Просмотрены desktop/mobile screenshots; browser PASS
подтверждён root/reviewer. Команда architect git diff --check → exit 0; make check не
повторялся. После gate меняется только протокол; код/tests при приёмке не менялись.
Блокеров нет, физические устройства не проверены. Handoff root: архивировать и коммитить
TRAIN-007; после коммита открыть SPEECH-001 по очереди. Git выполняет только root.

- Runtime участников: Codex gpt-6.1-sol high и gpt-6.1-terra high.
- Метаданные основной сессии недоступны; локальный коммит выполняет оркестратор.

## WORDS-003 — личные теги в редакторе и фильтре словаря

Статус: done (принят, ожидает root archive/commit). Попытка: 1.
Architect: gpt-6.1-sol, reasoning high.
Цель: создавать/назначать/снимать личные теги при сохранении слова, видеть их в списке
и отбирать слова по нескольким тегам, сохраняя остальные параметры словаря.
Основание: `.local/spec.md` §8, §14.2/14.5 и manual-feedback-2026-10-29.md.

### Наблюдаемые AC

1. WordForm для нового и существующего слова показывает выбранные теги и позволяет
   добавить новый либо выбрать уже существующий личный тег, снять любой или все.
   После успешного сохранения/reload в строке слова видны chips с сохранёнными именами.
   Отмена и ошибка сохранения не меняют серверные связи и не показывают ложный успех.
   При добавлении слова теги доступны внутри изолированного new-редактора: поиск,
   фильтры и список не возвращаются до отмены или успешного сохранения (WORDS-002).
2. До 20 тегов на слово; имя после NFC и схлопывания/trim Unicode whitespace содержит
   1..80 Unicode code points. Ключ уникальности — casefold этого имени, без подмены ё/е,
   пунктуации или апострофов. `  Работа ` и `работа` переиспользуют один тег владельца,
   его первоначальное отображаемое имя сохраняется; разные владельцы имеют разные теги.
   Повторы нормализованного ключа в одном payload отклоняются 422; UI не добавляет повтор.
   Сервер проверяет лимиты и типы, frontend заранее объясняет те же пределы.
3. Фильтр позволяет выбрать несколько личных тегов с явным обозначением «все выбранные»
   (AND). Без тегов выдача прежняя; q, sort, training и tag_id работают совместно;
   прежние стабильные сортировки сохраняются. Выбор/снятие тегов отражается в URL,
   reload и Back/Forward восстанавливают состояние. При пустом результате фильтра
   видна причина «ничего не найдено» и возможность снять теги, а не сообщение о пустой БД.
4. Чужие теги не попадают в список/подсказки/слова. Чужой word ID на чтении и записи —
   404; неизвестный или чужой tag_id фильтра — одинаковый 404. Нельзя создать связь
   разных owner даже прямой записью в БД. Мутации защищены CSRF, API no-store;
   пользовательские имена/ID тегов не сохраняются в browser storage.
5. Изменение только тегов не меняет progress (включая >100), content_version,
   training_version или is_excluded; открытый учебный item остаётся пригодным и ответ
   начисляется один раз. Смысловые изменения и ручное исключение сохраняют свои правила.
   Удаление слова удаляет его связи, сохраняя другие слова и их теги.
6. Upgrade существующей БД добавляет пустые теги/связи, сохраняя пользователей, слова,
   переводы, прогресс >100, флаги/версии, сессии и items. Alembic check совпадает с моделями,
   foreign_key_check чистый. Downgrade не теряет назначенные теги молча: при непустых новых
   таблицах отказывает с понятной причиной и полностью сохраняет схему/версию/данные;
   downgrade пустой схемы тегов работает.

### Контракты API и данных

Префикс всех путей `/api`. `TagOut = {id: string, name: string}`.

- `GET /tags` → 200 `TagOut[]`, только owner, порядок normalized_name ASC/id ASC.
  Возвращает и ранее созданные, но сейчас не назначенные теги для повторного выбора;
  список не зависит от текущих q/training/tag_id фильтров словаря. Неавторизованный — 401.
- `POST /words`, `PUT /words/{id}`: прежние поля плюс необязательный `tags: string[]`
  из имён (не ID), максимум 20. POST без tags создаёт без тегов; PUT без поля сохраняет
  текущие связи для совместимости прежних клиентов. Явное `tags: []` снимает все связи;
  null, нестроковые элементы, пустое/слишком длинное имя, >20 и повторы → 422.
  Find-or-create по owner+normalized_name и замена связей входят в одну транзакцию слова.
  Конкурентные сохранения одного нового имени не создают дубль и не дают 500:
  DB UNIQUE и upsert/re-read существующего личного тега. Ошибка откатывает всю операцию.
- Все прежние ответы WordOut, включая PATCH training, дополнены `tags: TagOut[]`;
  теги слова отсортированы normalized_name ASC/id ASC, отсутствие → [].
- `GET /words?...&tag_id=<id>&tag_id=<id>`: 0..20 ID, повтор ID идемпотентен;
  каждый ID должен принадлежать owner, иначе общий `404 tag_not_found` без чужих данных.
  Слишком длинные/пустые параметры и >20 → 422. AND по всем уникальным ID, без дублей
  слов; q/sort/training не меняют текущих defaults и allowlists.
- URL SPA использует те же повторяемые `tag_id`. Канонический массив ID для query key
  отсортирован и дедуплицирован: `['words', q, sort, training, tagIds]`; справочник `['tags']`.
  Успешное сохранение слова обновляет обе группы запросов, удаление/исключение — words;
  logout продолжает очищать приватный cache. Ошибка tags-list не блокирует ручной ввод
  и сохранение слова, но показывается явно; фильтр не заявляет успешную загрузку.
- `tags(id, owner_id, name, normalized_name)` с FK user CASCADE, UNIQUE(owner_id,
  normalized_name); normalized_name способен вместить результат расширяющего casefold.
  `word_tags(owner_id, word_id, tag_id)` с уникальной парой word/tag и составными
  FK на owner+word и owner+tag, CASCADE для связей. Нужные составные уникальные ключи
  родителей описываются и в моделях. Для существующей words использовать дополнительный
  UNIQUE index, без batch-пересоздания words/дочерних таблиц. У тегов нет учебных версий.
  SELECT тегов/связей явно scoped по owner; загрузка коллекций без async lazy-load ошибок.
- Новая линейная Alembic revision после текущего head; существующие миграции не менять.
  Только добавление таблиц/индексов в принятой транзакции миграций; при downgrade сначала
  проверка непустых таблиц. Не отключать FK вне принятого migration connection.

### Границы и владельцы файлов

- backend-agent: `backend/src/lexicona/models.py`, `routers/words.py`, новый `routers/tags.py`,
  небольшой модуль нормализации/записи тегов при необходимости, `main.py` (подключить router),
  новая `backend/migrations/versions/*_word_tags.py`; первоначальные backend-тесты тегов
  и миграций в `backend/tests/test_tags.py` / `test_app.py` либо отдельном файле миграций.
- frontend-agent после контракта backend: `frontend/src/api.ts`, `words.ts`,
  `components/WordForm.tsx`, `pages/WordsPage.tsx`, `pages/pages.module.css` и нужные
  тесты этих сценариев; разделить WordInput и WordOut tags в типах, сеть только api.ts,
  стили только через semantic tokens. Доступные поля/кнопки, keyboard и узкий экран.
- tests-agent после реализации: новые регрессии в `backend/tests/*tags*`,
  `test_app.py` и `frontend/src/{api,words}.test.*`, `pages/WordsPage.test.tsx`,
  новый тест WordForm при необходимости; production файлы не менять без handoff владельцу.
- code-reviewer: весь diff и подтверждённый gate; architect: только PROJECT/TASKS/archive.
  Devops не требуется. Исполнители не отменяют чужие правки, не делают Git/ветки.

Вне этого среза: глобальное переименование/удаление тегов и отдельный менеджер,
подборки/bulk, обучение по тегам, пагинация/другие фильтры и импорт/экспорт.
Это не отменяет их отдельный аудит для полного MVP после очереди ниже.

### Цепочка и проверки

backend-agent → frontend-agent → tests-agent → code-reviewer → architect → root archive/commit.
Целевые сценарии: round-trip создание/редактирование/очистка/PUT omission; повторное имя
и Unicode NFC/casefold/whitespace, сохранение различий ё/е и пунктуации; границы 20/21,
80/81 и нестроковые значения; два owner, чужие word/tag ID, 401/CSRF/no-store;
AND+q+sort+training, URL Back/reload, cache invalidation и сбой запроса; cosmetic edit
после старта занятия без потери ответа; populated upgrade и отказ downgrade без потерь,
DB запрет cross-owner связей, каскад при удалении слова. Конкурентный find-or-create
проверяется двумя независимыми сессиями БД, без мутаций рабочего дерева.

Команды для исполнителей: `cd backend && uv run --locked pytest tests/test_tags.py
tests/test_app.py` (добавить фактический файл migration regression, если отдельный);
`cd frontend && npm test -- src/pages/WordsPage.test.tsx` и фактические новые tests;
после конечного production/test diff — один `make check`. Сохранить exit code и числа
проверок/привязку к diff; после новых изменений воспроизводить нужные проверки.
Ревьюер и architect повторно полный успешный gate без причины не запускают.

Результаты: полный `make check` tests_next exit 0 — tooling 12, backend 255,
frontend 83; Ruff/format/mypy/Prettier/lint/typecheck/build и diff --check прошли.
Добавлены регрессии Unicode/пределов/owner, сохранения открытого item и populated
upgrade с переводом/сессией/item. Первые замечания Ruff/mypy в тестах исправлены.
Root реальный Chromium 156 + tempSQLite/uvicorn/SPA: создание новых тегов, выбор
существующего, снятие тега, AND/URL/reload, отдельный new-редактор и mobile390 без
overflow/pageerror — PASS. Начальные сбои harness (ожидание React checkbox и точный
getByLabel против имени combobox) исправлены только в /tmp; product diff не менялся.
Скриншоты /tmp/lexicona-tags-*.png просмотрены. Физические устройства не проверялись.
Независимый review_next: Ship; AC1–6 выполнены, подтверждённых дефектов нет. Проверены
все 19 файлов, включая untracked; casefold сравнен со всем Unicode16 — 0 расхождений.
Подтверждены gate 12/255/83 и browser PASS, мобильные скриншоты просмотрены.
Приёмка architect: ПРИНЯТО. AC1–6 проверены по конечным production/test файлам,
новым untracked, API/миграции, независимому Ship и подтверждённому gate 12/255/83.
Проверены создание/выбор/снятие и изолированный new-редактор, NFC/casefold/лимиты,
AND+URL/cache, owner/CSRF/составные FK, PUT omission, cosmetic и сохранение открытого
item, populated upgrade и отказ downgrade. Просмотрены desktop/editor-mobile screenshots;
browser PASS подтверждён root/reviewer. Теги не отправляются внешним API/storage.
Команда architect git diff --check → exit 0. Успешный make check не повторялся;
чтение кода и screenshots не выдаётся за прогон. После gate менялся только протокол/README.
Блокеров нет; физический телефон не проверен. PROJECT отражает реализованную схему
и query key с tagIds. Handoff root: архивировать/коммитить WORDS-003, после коммита
открыть TRAIN-007; пока он остаётся в очереди. Git выполняет только root.

- Runtime участников: Codex gpt-6.1-sol high и gpt-6.1-terra high.
- Метаданные основной сессии недоступны; локальный коммит выполняет оркестратор.

## ACCOUNT-001 — профиль, смена пароля и проценты в настройках

- Цель: login в шапке открывает личные настройки, где видны аккаунт/сложность и доступна
  самостоятельная смена пароля; все учебные дельты подписаны знаком %.
- Статус: done; попытка: 2; приёмка architect: ПРИНЯТО.
- Источник: manual-feedback-2026-10-29.md и разделы 6.2–6.3/7.1 приватного ТЗ.

### AC

1. Login в шапке — доступная клавиатурой ссылка на существующий /settings. Экран явно
   показывает текущий login, настройки сложности и форму смены пароля. Дополнительный
   профильный маршрут, email, аватар, редактирование login и открытая регистрация не нужны.
2. Дельты во всех пяти строках сложности подписаны %, например «выбор ±4% · ввод +8%/−4%».
   Сами таблица дельт и действие настройки только на будущие занятия не меняются.
3. Смена пароля доступна только авторизованному владельцу текущего аккаунта с правильным
   X-CSRF-Token и текущим паролем. Новый пароль — строго строка 12..128 Unicode-символов,
   включая пробелы; ничего не trim/normalize. Прежний login/пароль, чужие ID и лишние поля
   не позволяют сменить чужой пароль. Ошибки не меняют hash/сессии.
4. Успешная смена атомарно меняет hash, отзывает ВСЕ прежние сессии этого пользователя
   (включая прежнюю текущую), создаёт одну новую текущую с новым cookie token и CSRF.
   Пользователь продолжает работу; старый пароль больше не входит, новый входит.
   Прежние cookies не авторизуют, прежний CSRF с новой cookie отвергается; сессии
   другого пользователя, его пароль/данные остаются действующими.
5. Защита конкуренции: CAS по фактически проверенному старому hash и ещё действующей
   сессии в write path; две конкурирующие смены не могут обе победить/создать сессии.
   Проигравший не устанавливает/не очищает cookie победителя. Проверка/хеширование Argon2
   не блокируют event loop; до вычисления не держать write-lock/длинную транзакцию.
   Login, проверивший старый hash до смены, не может записать новую авторизацию после
   смены на основании устаревшей проверки (запись сессии также привязана к hash).
6. Форма содержит current/new/confirmation, password inputs и корректные autocomplete.
   Confirm проверяется клиентом, Enter отправляет один запрос; pending блокирует повтор.
   Client считает длину Unicode code points согласованно с сервером, а не UTF-16 units;
   нельзя отвергать допустимые emoji/Unicode через неподходящий maxlength.
7. Success показывается только после ответа: frontend вызывает rememberSession с новым
   SessionOut, очищает все поля паролей и сообщает об отзыве остальных сессий.
   Следующая CSRF-мутация работает. Неверный текущий пароль объясняется без выхода
   из аккаунта; ошибка сохраняет форму для исправления. Пароли/tokens не попадают в URL,
   logs, localStorage/sessionStorage; body запроса — только через api.ts.
8. Сетевой/JSON-сбой после возможного commit не выдаётся за успех и не вызывает скрытого
   повторения смены пароля. Для согласования cookie/CSRF можно перечитать /auth/me и
   rememberSession; иначе явно нужен повторный вход. Перечитывание сессии не доказывает,
   что пароль изменился. Возвращённый после выхода/смены аккаунта старый ответ не должен
   восстанавливать старую учётку ни в cache, ни после reload через оставшуюся HttpOnly-cookie.
   Одной очистки query cache недостаточно: поздняя ротация требует серверного cleanup и
   сохраняющегося после reload запрета автоматического восстановления при его сбое.
9. Endpoint всегда no-store, strict validation/owner/CSRF и конкуренция покрыты API-тестами;
   link/form/Unicode/feedback/rememberSession покрыты UI-тестами. Финальный make check зелёный.

### API и сессии

- POST /api/auth/change-password: strict payload {current_password:string,new_password:string},
  extra forbid. current_password — 1..256 символов (совместимо с прежним login), new_password
  — 12..128; без strip_whitespace/нормализации. Не принимать user_id/login/confirmation.
- Успех HTTP 200 со стандартным SessionOut {user,csrf_token}; cookie как при login:
  SESSION_COOKIE, HttpOnly, SameSite=Lax, Path=/, Secure из AppSettings, lifetime прежний.
  В БД token только в виде hash; CSRF/cookie генерируются заново.
- Неверный current_password: HTTP 400 {detail:"invalid_current_password"}, без Set-Cookie
  и без отзыва сессий. Это не 401, потому что global onError(401) вызывает forgetSession.
  Отсутствующая/отозванная сессия и проигранный CAS после её отзыва — 401 not_authenticated,
  без Set-Cookie; неверный CSRF — 403, некорректный body — 422.
- Failed password checks ограничить отдельным throttle по auth.user.id, используя текущий
  одно-процессный подход LoginThrottle; не смешивать счётчик с login. После порога 429
  too_many_attempts, успех сбрасывает счётчик. Никаких новых Redis/очередей.
- В короткой write-транзакции проверяются старый hash и живая исходная session; при CAS
  успехе delete AuthSession по user_id и insert новой записи. Не создавать миграцию:
  текущие User/AuthSession уже содержат нужные поля. Проверить конкуренцию с logout
  и login на старом hash; обычные login/logout/settings контракты сохраняются.
- api.changePassword(currentPassword,newPassword): Promise<Session>. Форма находится на
  SettingsPage; onSuccess обновляет csrf и session через rememberSession, не ручным
  setQueryData только user. Pending difficulty/password мутаций координировать, чтобы
  поздняя запись старого user не подменила свежие настройки/новую CSRF-сессию.

### Исправление AC8 в попытке 2 — поздняя cookie и перезагрузка

- Объединить только auth-операции login/logout/change-password последовательным каналом
  в session.ts; не строить общий framework запросов. Logout/переход к другой учётке
  сразу меняет revision и очищает локальные данные, но новый login отправляется после
  завершения прежней ротации/её cleanup. В очередь включается обработка ответа, не только
  fetch: новый login не должен обогнать cleanup и затем быть стёрт поздним logout.
- При выходе/инвалидации из-за поздней ротации сохранить sessionStorage boolean
  require-explicit-login (один служебный признак, без пароля/токена/CSRF/слов/user ID).
  При этом признаке loadSession после reload не делает автоматический /me restore и
  оставляет экран явного входа. Удалять признак может только актуальный успешный explicit
  login после предшествующих auth-операций; rememberSession от /me/change-password и
  запоздалый callback не имеют права его снимать.
- Успешный change-password, ставший stale по revision/user, не принимать локально.
  Пока auth-канал удерживается, через api.ts отправить POST /auth/logout с CSRF именно
  этого позднего SessionOut: браузер уже применил его cookie. CSRF override передаётся
  только в заголовок конкретного cleanup-запроса; не записывать его как токен другой
  активной учётки. Успешный cleanup реально отзывает позднюю сессию, 401 означает, что
  она уже не действительна. После cleanup cache остаётся очищенным, служебный признак
  сохраняется до явного входа.
- При сетевом сбое cleanup, потерянном/нечитаемом body после Set-Cookie или неуспешном
  согласовании не обещать отзыв и не разрешать auto-restore: признак остаётся после
  reload. /me в рамках recovery сам по себе не доказывает намерение войти и не снимает
  блокировку. Явный новый login позже устанавливает свою cookie/CSRF и только затем
  снимает признак. Не пытаться удалить HttpOnly-cookie JavaScript-кодом.
- Регрессии обязаны моделировать cookie-side effect позднего ответа, а не только порядок
  setQueryData: Alice change commit/response delay → logout → попытка login Bob → поздний
  Alice response/cleanup → Bob login. Порядок запросов не допускает Bob до cleanup;
  после успеха Bob действует и reload не возвращает Alice. Отдельно cleanup network failure
  и потерянный body: remount/reload с сохранённым sessionStorage не восстанавливает Alice,
  explicit login разрешён и снимает признак только после успеха. Проверить stale login
  callback и /me, чтобы они также не обходили этот запрет.

### Владельцы, цепочка и проверки

1. architect: TASKS.md/PROJECT.md, контракт и приёмка после Ship.
2. backend-agent: backend/src/lexicona/routers/auth.py, при необходимости security.py/deps.py,
   соответствующие backend/tests/**; endpoint/CAS/revocation/login-guard/throttle.
3. frontend-agent: frontend/src/{api,session}.ts, components/Layout.tsx,
   pages/{SettingsPage,LoginPage}.tsx, при необходимости CSS и тесты; ссылка, профиль/форма,
   знаки %, auth-координация, cleanup и безопасный session update после reload.
4. tests-agent: backend/tests/**, frontend/src/**/*.test.ts(x); AC и make check финального diff.
5. code-reviewer: весь diff, секреты/CSRF/owner/CAS/rotation/late responses + gate → Ship.
6. architect: ПРИНЯТО / НА ДОРАБОТКУ; root архивирует и коммитит один законченный срез.
- Backend: правильный/неверный current, границы нового пароля и Unicode с пробелами,
  strict/extra/anon/CSRF/no-store, 2+ сессии владельца и другой owner, новый/старый login,
  свежая CSRF-мутация, повтор/параллельные смены, logout и stale-login race, throttle.
- UI: login link→settings, профиль и все %, invalid confirmation/length без запроса,
  Enter/pending/repeat, wrong current без logout, success clear+rememberSession,
  network uncertainty/recovery и отсутствие позднего восстановления другого аккаунта
  с учётом cookie/reload/cleanup failure и persistent explicit-login guard.
- Команды: целевые pytest/vitest, затем make check и git diff --check.
- Вне scope: регистрация/invites/recovery, удаление аккаунта, каталог активных сессий,
  email/avatar/login change, теги/TTS/варианты/lookup. Остальной MVP остаётся в работе.
- Полный `make check` tests-agent: exit 0 — tooling 12, backend 248, frontend 70;
  Ruff/mypy/Prettier/oxlint/tsc/build и `git diff --check` зелёные. Добавлена регрессия
  позднего /auth/me при reconciliation после смены аккаунта; прочие AC покрыты,
  включая детерминированные Argon2/logout/stale-login гонки и CAS.
- Root live HTTP smoke: exit 0 на временной мигрированной SQLite и реальном uvicorn/SPA;
  Unicode+пробелы, неверный current, strict/CSRF, cookie/CSRF rotation, отзыв 2+ сессий,
  другой владелец, старый/новый login и две параллельные смены (200/401, loser без
  Set-Cookie) подтверждены. Продуктовая БД не использовалась. Ревью/приёмка: ожидаются.
- Ревью попытки 1: No-Ship, P2 против AC8. Задержанный успешный change-password Alice
  после logout/login Bob устанавливает валидную Alice cookie; очистка только cache
  допускает восстановление Alice после reload через /auth/me. Reviewer воспроизвёл
  на временной SQLite с cookie jars; прочий diff принят, лично 19 backend/10 UI passed.
  Нужен реальный отзыв поздней сессии/координация auth-операций и регрессия reload.
- Попытка 2: общий auth-канал сериализует запросы и обработку login/logout/password;
  поздняя сессия реально отзывается, служебный boolean требует явного входа при
  неуспехе cleanup и не содержит слов/паролей/токенов. Cookie-модель покрывает reload.
  Новый `make check` tests-agent exit 0: tooling 12, backend 248, frontend 75;
  Ruff/mypy/Prettier/oxlint/tsc/build и diff --check зелёные.
  Root повторил live HTTP smoke с воспроизведением позднего Alice Set-Cookie,
  реальным POST/logout с его CSRF: обе Alice cookie jars получили 401, Bob session
  сохранился, явный вход Bob и fresh /me после имитации reload вернули Bob. Exit 0.
  Ручного браузерного прогона нет. Повторное ревью/приёмка ожидаются.
- Независимый reviewer попытки 2: Ship; P2 устранён, новых замечаний нет, AC выполнены.
  Лично 15 UI/session-тестов passed, diff --check успешен; подтверждён gate 12/248/75.
- Приёмка architect: ПРИНЯТО. Прочитаны конечный diff и новые API/UI/session-регрессии;
  AC 1–9 выполнены. CAS/rotation/revocation, строгий Unicode payload, проценты и профиль
  согласованы с контрактом. Finding AC8 закрыт общим auth-каналом, реальным cleanup поздней
  сессии и persistent explicit-login guard; cookie-модель покрывает reload и сетевой отказ.
  Приняты независимый Ship, новый make check 12/248/75 и реальный расширенный HTTP smoke;
  gate без изменений не повторялся. Лично git diff --check — exit 0.
  Ограничение: физического браузерного прогона нет; продуктовая БД не менялась.
  Передано root для архива и коммита; WORDS-003 открывать после коммита. Общий MVP в работе.

- Runtime участников: Codex gpt-6.1-sol high и gpt-6.1-terra high.
- Метаданные основной сессии недоступны; локальный коммит выполняет оркестратор.

## TRAIN-006 — большие занятия и собственное число слов

- Цель: пользователь начинает занятие выбранного размера вплоть до 500 слов и видит
  фактически доступное число заданий, если личного пригодного словаря меньше.
- Статус: done; попытка: 1; приёмка architect: ПРИНЯТО.
- Источник: прямое дополнение пользователя от 2026-10-30 в manual-feedback; WORDS-002 принят.

### AC и контракты

1. POST /api/training/sessions принимает size только как JSON integer 1..500 включительно.
   Пропущенный size остаётся 10. 0, отрицательное, 501+, bool, строка, дробь, null дают 422;
   даже 3.0 не приводится молча к целому. mode/direction и формы SessionOut/ItemOut прежние.
2. Все четыре текущих режима поддерживают новый предел: choice/input/cards EN→RU/RU→EN,
   cloze EN→EN. Размер — максимум уникальных личных активных подходящих слов, а не
   требование заполнить занятие дубликатами. Сервер отдаёт min(size, eligible_count),
   соблюдая прежний порядок наименьшего прогресса и прежние критерии пригодности.
   Исключённые и чужие слова не попадают в targets/distractors; новых публичных ответов нет.
3. Если пригодных слов нет, сохраняются прежние 409/not_enough_words или
   no_eligible_cloze_examples. Малый pool не приводит к пустому успешному занятию.
   В choice по-прежнему четыре однозначных варианта; шесть будут отдельным TRAIN-005.
4. Setup сохраняет presets 5/10/20/30 и добавляет 50/75/100/125/150. Есть подписанное
   поле «Своё число слов» с объяснением 1–500 и доступной валидацией. Presets и поле
   управляют одним выбранным размером: кнопка заполняет поле, ручной ввод обновляет
   выбранное состояние. Default 10; смена режима/направления не стирает размер и наоборот.
5. Пустое/дробное/вне диапазона значение не округляется и не clamp-ится; UI показывает
   ошибку/инструкцию и не отправляет запрос. Валидное число отправляется как number.
   Доступен старт по Enter из поля; presets сами не начинают занятие. Pending блокирует
   повторный старт и смену настроек до ответа; ошибка API сохраняет введённое число/режим.
6. После старта виден реальный total из session.items.length. Если он меньше запрошенного,
   UI прямо объясняет: «Доступно N из Y запрошенных слов»; не создаёт фиктивных вопросов.
   Для этого requested size можно сохранить в состоянии экрана, без изменения API-схемы.
   Run/next/feedback/summary/outcome/CAS/progress-policy работают как раньше.
7. Подготовка 500 заданий проверена на реальном временном SQLite без HTTP-создания каждого
   слова в fixture; зафиксированы фактические результаты/время. Не добавлять фоновую очередь,
   кэш, пагинацию упражнений или переписывание генератора без обнаруженной необходимости.
   Финальный make check зелёный, новые границы и поведение покрыты API/UI-регрессиями.

### Владельцы, цепочка и проверки

1. architect: TASKS.md, при необходимости PROJECT.md; приёмка после Ship.
2. backend-agent: backend/src/lexicona/routers/training.py и соответствующие backend/tests/**;
   strict size и API-проверки. Новая миграция/схема БД не требуются.
3. frontend-agent: frontend/src/pages/TrainingPage.tsx, при необходимости api.ts/CSS module
   и соответствующие frontend/src/**/*.test.ts(x); presets/поле/валидация/реальный total.
4. tests-agent: backend/tests/** и frontend/src/**/*.test.ts(x); AC, большие/малые pools,
   регрессии текущих режимов и полный make check для конечного diff.
5. code-reviewer: весь diff/AC и подтверждённый gate → Ship / No-Ship.
6. architect: ПРИНЯТО / НА ДОРАБОТКУ; root архивирует и делает один коммит задачи.
- API: default и strict invalid values, границы 1/500, пресеты 50/75/100/125/150;
  большой input/cards/choice/cloze pool, меньший пригодный pool и отсутствие дублей;
  неподходящие cloze, исключённые/чужие слова, CSRF/no-store и прежний 409.
- UI: все presets и custom, валидный Enter/invalid без запроса, сохранение режима/размера
  при переключении и API error/retry, pending, сокращённое занятие с N/Y, обычный run.
- Команды: целевые pytest/vitest при реализации, затем make check и git diff --check;
  для больших выборок не вводить хрупкий wall-clock порог теста, измерение указать в отчёте.
- Вне scope: шесть вариантов ответа, новые режимы/SRS, voices/auto-TTS, профиль/пароль,
  теги/lookup, сохранение размера в аккаунт или browser storage, деплой.
- Backend gate: `make check-backend` exit 0 — Ruff/mypy, 229 тестов.
- Frontend gate: `make check-frontend` exit 0 — формат/lint/types/build, 58 тестов.
- Подготовка 500 items на реальной временной SQLite, слова созданы одной транзакцией:
  input EN→RU/RU→EN 0,043/0,039 с; cards 0,039/0,029 с; choice 0,107/0,106 с;
  cloze 0,043 с. Единичные фактические измерения, не SLA и не тестовый порог.
- Общий `make check` tests-agent: exit 0 — tooling 12, backend 229, frontend 58;
  Ruff/mypy/Prettier/oxlint/tsc/build и `git diff --check` зелёные. Tests-agent подтвердил
  достаточность регрессий без формальных дополнительных тестов. Ревью/приёмка: ожидаются.
- Независимый reviewer: Ship, замечаний нет, AC выполнены. Лично 13 backend- и 11 UI-
  тестов passed, diff --check успешен; подтверждён общий gate 12/229/58.
  Ручного браузерного прогона не было.
- Приёмка architect: ПРИНЯТО. Прочитаны конечный diff и новые size API/UI-регрессии;
  AC 1–7 выполнены: strict integer 1..500/default 10, все presets/custom, Enter,
  pending/error/retry, реальные активные пригодные items без дублей и пояснение N/Y.
  Формы API и четыре choice-варианта сохранены. Приняты независимый Ship, подтверждённый
  make check 12/229/58 и измерения 500 items; gate без изменений не повторялся.
  Лично git diff --check — exit 0. Передано root для архива и коммита; ACCOUNT-001
  открывать после коммита, общий MVP и остальная очередь остаются в работе.

- Runtime участников: Codex gpt-6.1-sol high и gpt-6.1-terra high.
- Метаданные основной сессии недоступны; локальный коммит выполняет оркестратор.

## WORDS-002 — ручное исключение из обучения и прогресс выше 100%

- Цель: слова остаются в словаре после 100%; пользователь вручную исключает/возвращает
  слово, а последующая практика может увеличивать реальный процент выше 100.
- Статус: done; попытка: 1; приёмка architect: ПРИНЯТО.
- Источник: прямое решение пользователя, .local/requirements/manual-feedback-2026-10-29.md.
  Новая policy заменяет прежний верхний clamp, не добавляет автоархивирование.

### AC

1. Прогресс — целое >=0 без верхнего clamp 100; положительный ответ при 98/100/150
   даёт полную дельту сложности, отрицательный уменьшает до минимум 0. Все текущие
   режимы используют одну policy; snapshot difficulty, meaning reset, CAS и нулевая
   дельта помощи/пропуска сохранены. Достижение 100 ничего не удаляет и не исключает.
2. У слова отдельный обратимый is_excluded, default false. «Исключить из обучения» и
   «Вернуть в обучение» сохраняют слово, переводы, прогресс и content_version. Только
   фактическая смена состояния увеличивает отдельный training_version; повтор того же
   запроса идемпотентен. Обычное редактирование не переключает этот флаг.
3. Словарь фильтруется по active/excluded/all; поиск и шесть сортировок работают внутри
   выбранной области. Фильтр сохраняется в URL и query key; есть понятный статус и
   доступная кнопка возврата, включая error/retry. Исключённое слово можно прочитать,
   отредактировать и удалить обычным явным действием; исключение не является delete.
4. Все новые занятия используют только активные личные слова и для targets, и для
   distractors. На уже открытый item исключение действует без штрафа: первый запрос
   answer/reveal/skip к недоступному item закрывает unavailable с delta 0, без correct,
   grade и раскрытия ответа. Возврат слова не оживляет старый item: snapshot training_version
   должен совпадать. Новая сессия после возврата работает с сохранённым прогрессом.
5. Терминальный результат, принятый до исключения, сохраняется при replay; начисление
   не повторяется. Гонки ответа/раскрытия/пропуска с исключением сериализуются по записи:
   если ответ принят первым — одна обычная дельта; если исключение первым — нулевая
   unavailable. Eligibility/version проверяются в write path, а не только до CAS.
   После exclude→return старые items не начисляют даже при одновременных запросах.
6. UI показывает фактический процент, например 158%; заливка и aria-valuenow ProgressBar
   ограничены 0..100, aria-valuetext сообщает реальный прогресс. В тренировке unavailable
   отображается как «Задание недоступно: слово исключалось из обучения», с «Далее»;
   недоступные отдельно считаются в итоге, не попадают в correct/incorrect/graded.
7. Новый endpoint и фильтр соблюдают owner_id/404, CSRF на мутации и no-store; чужое
   слово невозможно исключить/вернуть и использовать через старый item. Некорректные
   body/фильтр дают 422. Миграция сохраняет все существующие слова и дочерние записи.
8. Policy-specific unit/API/UI-тесты и документы согласованы с новой policy; конечный
   make check зелёный для финального diff. Остальная очередь и автономный режим продолжаются.

### API и схема

- WordOut дополнить is_excluded:boolean; WordIn не даёт управлять прогрессом/версией/флагом.
  PATCH /api/words/{word_id}/training с {is_excluded:boolean}, strict boolean и extra forbid,
  возвращает актуальный WordOut. Изменение флага и training_version — атомарное обновление
  с owner_id и условием фактической смены состояния; повтор не увеличивает версию.
- GET /api/words: training=active|excluded|all, default active. Существующие q/sort и
  формат списка сохраняются; GET /words/{id} возвращает и собственное исключённое слово.
- api.listWords(q, sort='created_desc', training='active'); query key
  ['words',q,sort,training], общая invalidation ['words']. URL-параметр training, default
  active можно опускать; неизвестное значение URL безопасно трактуется UI как active.
- Word: is_excluded boolean NOT NULL default false; training_version integer NOT NULL
  default 1. TrainingItem: word_training_version integer NOT NULL default 1, snapshot
  при создании. Существующие items получают 1, outcome сохраняется. Word.progress
  check заменяется на progress>=0. TrainingItem.outcome расширяется до String(16).
- TerminalOut добавить {outcome:"unavailable", reason:"training_state_changed",
  delta:0, progress:int}; в БД outcome unavailable, answered_at заполнен,
  is_correct/chosen_option/submitted_text/grade NULL. Reason постоянен для этой категории.
  Существующие answer/reveal/skip возвращают фактический канонический TerminalOut;
  карточный reveal остаётся нетерминальным только для доступного item. У уже закрытого
  item приоритет сохранённого результата. Строгая валидация answer по режиму сохраняется.
- Для начисления одновременно требуются owner_id, !is_excluded, совпадение
  word_training_version и content_version, CAS незавершённого item. Несовпадение
  content_version без смены training_version сохраняет прежний meaning-edit контракт
  (snapshot answer с delta 0), не превращается автоматически в unavailable.
- Изменение схемы только Alembic; в SQLite пересоздание words НЕ должно каскадно удалить
  word_translations/training_items при включённом foreign_keys. Способ безопасного
  изменения FK/транзакции обосновать и проверить на непустой БД; PRAGMA foreign_key_check
  после upgrade пуст. Downgrade отказывается без потерь, если progress>100, есть excluded,
  training_version!=1 или unavailable (иначе старые items могут снова стать пригодными).
  При безопасных данных downgrade/upgrade возможен без потери связей и результатов.
- Продуктовую БД в этом срезе не мигрировать: проверки на временной копии. Для реального
  обновления документировать резервную копию SQLite через backup API с учётом WAL;
  не подменять её копированием только основного файла работающей БД.

### Владельцы, цепочка и проверки

1. architect: TASKS.md/PROJECT.md, контракт и приёмка после Ship.
2. backend-agent: backend/src/lexicona/{models,progress}.py, routers/{words,training}.py,
   backend/migrations/**, соответствующие backend/tests/**. Реализовать policy, состояние,
   write-path eligibility/CAS, безопасную миграцию и передать точный контракт frontend.
3. frontend-agent: frontend/src/api.ts, pages/{WordsPage,TrainingPage}.tsx,
   components/ui.tsx, при необходимости CSS и соответствующие тесты; фильтр/кнопки,
   реальный процент и доступная шкала, unavailable/summary/loading/error/retry.
4. Оркестратор: AGENTS.md/README.md — заменить устаревшие правила 0–100 и описать ручное
   исключение, новую policy и порядок backup/миграции. PROJECT.md обновляет architect
   после реализации, исторические архивы и исходные старые требования не переписывать.
5. tests-agent: backend/tests/** и frontend/src/**/*.test.ts(x); AC/регрессии и make check.
6. code-reviewer: весь diff, миграция/сохранение связей/гонки и подтверждённый gate → Ship.
7. architect: ПРИНЯТО / НА ДОРАБОТКУ; оркестратор архивирует и делает один коммит задачи.
- Тесты: progress>100/нижняя0 во всех правилах; owner/CSRF/no-store/strict/filter+q+sort;
  pool targets/distractors; exclude/return/repeat без resetprogress, старые items до/после
  возврата, терминальный replay и mixed races; новые занятия после возврата; meaning edit;
  карточный reveal→exclude→grade, cloze snapshot; миграция с users/words/translations/
  sessions/open+answered items и FK-check; safe downgrade и отказ на новых данных.
- UI: active/excluded/all+URL, исключение/возврат и ошибка, 158% с bar100/aria,
  unavailable→next→summary; целевые pytest/vitest, затем make check и git diff --check.
- Вне scope: SRS/автоматический архив, изменение difficulty/delta table, теги/профиль/TTS,
  число вариантов, размер занятий и lookup. Их карточки открываются после этого среза.
- Backend gate: `make check-backend` exit 0, Ruff/mypy и 213 тестов.
- Frontend gate: `make check-frontend` exit 0, формат/lint/types/build и 47 тестов.
- Оркестратор: live HTTP smoke exit 0 на отдельной временной SQLite с миграциями,
  реальном uvicorn и собранном SPA. Прогресс 112%/120%, отсутствие автоисключения,
  exclude/return, старые items/cards, replay, pool, фильтры/сортировка, строгий payload,
  два владельца/CSRF/404 и гонка ответа с исключением проверены. Продуктовая БД не
  использовалась; ручного браузерного прогона не было.
- Общий `make check` tests-agent: exit 0 — tooling 12, backend 216, frontend 47;
  Ruff/mypy/Prettier/oxlint/tsc/build и `git diff --check` зелёные. Дополнены гонки
  reveal/skip с исключением и параллельные answer/reveal/skip после exclude→return:
  один результат, нулевая дельта, отсутствие утечки. Ревью/приёмка: ожидаются.
- Независимый reviewer: Ship, AC выполнены, замечаний нет. Лично 49 backend- и 14
  UI-тестов passed, diff --check. На отдельной временной SQLite намеренно провалил
  foreign_key_check и подтвердил полный откат схемы, Alembic-версии и данных.
  Подтверждён общий gate 12/216/47.
- Приёмка architect: ПРИНЯТО. Прочитаны весь конечный diff, миграция d90b58c2a113 и
  новые API/UI-регрессии. AC 1–8 и контракты выполнены: progress>=0, ручное исключение,
  отдельная training_version, write-path eligibility/CAS, прежний terminal replay,
  unavailable без раскрытия/штрафа, фильтры и bar/aria. Миграция сохраняет дочерние строки
  и атомарно отказывается при FK-дефекте/небезопасном downgrade; backup-порядок описан.
  Приняты независимый Ship, подтверждённый make check 12/216/47 и live HTTP smoke для
  конечного diff. Лично git diff --check — exit 0; gate повторно не запускался.
  Продуктовая БД не менялась; ручного браузерного прогона нет. Передано оркестратору
  для архива и коммита. TRAIN-006 открывать после коммита; общий MVP ещё в работе.


### Уточнение интерфейса по ручной проверке (2026-10-30)

- Попытка 2: ПРИНЯТО. Exclude/return перенесены в компактную группу рядом с edit/delete;
  доступны aria-label/title, pending/error/retry и сохранение прогресса.
- Sort/training стоят в одной desktop-строке с переносом на узком экране. У активных
  слов убрана подпись «В обучении»; excluded-статус и возврат сохранены.
- После «Добавить слово» видны только заголовок и редактор: поиск, фильтры, список и их
  сообщения скрыты. Cancel/save сохраняют URL; ошибка сохранения держит черновик.
- Полный make check: exit 0, tooling 12 / backend 248 / frontend 77; формат/статика/build
  и diff --check прошли. Независимый review_next: Ship; architect: ПРИНЯТО.
- Root проверил настоящий headless Chromium 156 на tempSQLite/uvicorn/SPA: desktop1280
  и mobile390, координаты controls, изолированный редактор/cancelURL, 158%/bar100,
  отсутствие overflow и pageerror. Скриншоты просмотрены root и reviewer/architect.
- Уточнение включается в тот же исторический коммит WORDS-002; последующие принятые
  задачи сохраняются. Будущая очередь и план тегов не относятся к этому product diff.

- Runtime участников: Codex gpt-6.1-sol high и gpt-6.1-terra high.
- Метаданные основной сессии недоступны; локальный коммит выполняет оркестратор.

## TRANSLATE-001 — DeepL и Gemini для неизвестных фраз (2026-11-03)

Статус: done. Реализованы настройки DeepL/Gemini, fallback только после пустого локального lookup,
strict/bounded HTTP, machine_translation без FreeDict provenance и выбор переводов/US IPA в форме.
Live DeepL и Gemini проверены; секреты не коммитились. Финальный общий gate после стабилизации
двух unrelated random-order тестов: tooling 17, backend 329, frontend 131, все проверки зелёные.
Независимый reviewer ранее не нашёл дефектов diff; финальный Ship подтверждён для общего среза.

## UX-001 — подсказки, озвучка и примеры в редакторе (2026-11-03)

Статус: done. Добавлены EN-озвучка, полные русские POS, очистка wiki-разметки и генерация EN/RU
примера через Gemini с auth/CSRF/no-store. Cloze исключён из UI и API новых занятий, legacy snapshots
и cards сохранены. Популярность и голоса не имитируются. Находки первого No-Ship (API cloze,
request-id, POS map) исправлены; конечный make check зелёный, независимый reviewer вернул Ship.

## TRAIN-RETRY-001 — исправление ошибки без повторного штрафа (2026-11-03)

Статус: done. В choice/input/legacy cloze первая ошибка применяет дельту и SRS один раз, последующие
попытки имеют delta=0 и не трогают SRS, правильный ответ закрывает item. UI не раскрывает ответ до
исправления и сохраняет reveal/skip. CAS, гонки и отсутствие утечки ответа проверены. Общий gate:
backend 329, frontend 131; финальный независимый Ship.

## UX-002 — исправление опечаток и стабильный порядок тестов (2026-11-03)

Статус: done. SpeakButton перенесён к полю headword. При пустом exact lookup локальный pinned index
возвращает до трёх близких написаний; UI объясняет отсутствие точного совпадения, выбор подсказки
подставляет слово и повторяет lookup. Live `corsar` предлагает `corsair`. Два прежних теста больше
не зависят от неопределённого порядка SQLite: choice проверяет reversed population, SRS — состав
due/new/future. `make fmt && make check` зелёный: tooling 17, backend 329, frontend 131, ruff/mypy,
format/lint/typecheck/build. Независимый reviewer: Ship, дефектов нет; лично 24 backend и 19
WordForm тестов, diff --check.

## UX-003 — действия с примерами и ясные учебные экраны (2026-11-03)

Статус: done; попытка: 1; приёмка оркестратора: ПРИНЯТО. После генерации примера доступны
«Добавить ещё 1 пример» и «Заменить пример»: append разделяет EN/RU-пары пустой строкой, replace
перезаписывает оба поля, превышение 2000 символов сохраняет прежний текст. Request-id по-прежнему
отбрасывает поздние ответы. Создание и редактирование слова изолированы от поиска, фильтров и списка,
URL сохраняется. Ответ карточки после серверного reveal крупно показан на обороте с ручной озвучкой;
оценка, пропуск и unavailable сохранены. Новый TTS-движок и имитация голосов вне scope.
Финальный `make check` зелёный: tooling 17, backend 329, frontend 134, ruff/mypy/format/lint/
typecheck/build. Dev frontend/backend отвечают HTTP 200. Независимый reviewer: Ship, дефектов нет;
лично 57 затронутых UI-тестов и diff --check.

## UI-004 — responsive density and full UI review (2026-11-11)

Status: done. Accepted by root after independent Ship, attempt 2.
Owners: frontend-agent (frontend/src and gate), root (browser checks and protocol),
code-reviewer (read-only review). API, schema and product scope are unchanged.

Acceptance criteria met: compact phone dictionary, slightly denser desktop,
visible active-filter summary with URL/per-user persistence, native keyboard
disclosures for filters and labeled secondary word actions, readable body/input
text, wrapping long content, preserved progress/status/pending/error semantics,
and a single main scrollport. Static tag badges and SVG speech icons reduce
wasted space. Route/editor changes reset scroll; filter changes preserve it.

Review covered dictionary, editor, training setup/exercises, statistics, settings,
account and login. Attempt 1 found enlarged-text rate/navigation overlap and a
desktop list shrinking below its contents. Attempt 2 fixes both; enlarged labels
wrap and page/list retain natural height. No blocking findings remain.

Verification:

- Final make check with pipefail and captured output: exit 0; tooling 30,
  backend 422, frontend 193; formatting, ruff, mypy, lint, typecheck/build pass.
  Tooling includes unrelated untracked sync tests present in the shared tree;
  their implementation is not part of this ticket. UI file hashes matched gate.
- Chromium: 35 layout cases at 320/390/768/1280 and enlarged root text 200%,
  including login and editor. No main horizontal overflow or page exceptions.
  The statistics table retains its own contained scrolling at enlarged text.
- Live isolated API: keyboard Enter disclosures, tag filtering/reload/clear,
  learned and exclude/restore without progress loss, editor/cancel/navigation
  scroll reset; choice/matching/input start at all four widths.
- Identical fixture comparison, EN/RU speech controls enabled: at 390x844,
  ordinary rows 189px -> 137px, list starts at 429px -> 203px, fully visible
  short records 1 -> 4. At 1280x844, list starts at 280px -> 172px and fully
  visible records 4 -> 5; ordinary desktop row height stays 118px.
  Long content grows naturally; these counts are not universal device promises.
- Independent code-reviewer: Ship. git diff --check passes.

Local ignored evidence: .local/ui-review-ui004/ (gate log, JSON and PNGs).
Gate log SHA256: 0a72e971be79d86629c2d357b5eae93860bd57069a1c8c7d59bcf08f8fde152e.
Orca DOM checks worked; its screenshot capture timed out, so installed headless
Chromium supplied visual evidence. No production data, deployment or external
service calls were needed. Physical Android/iOS and audible speech remain
unverified. Exact root-session model metadata was unavailable; its AI trailer is
omitted. Verified contributing implementation model: gpt-6.1-terra.

## UI-005 — sticky controls, difficulty redesign and training count (2026-11-11)

Status: done. Accepted by root after independent Ship, attempt 2.
Owners: backend-agent (selection/API/tests), frontend-agent (UI/tests/final gate),
root (contract, browser checks and protocol), architect (preview consistency
advice), code-reviewer (independent read-only review).

All requested outcomes are implemented: reduced Training header padding, a
compact count beside Start, pinned dictionary search/add/filter controls, and a
single five-level difficulty selector with the saved level's gain/penalty table.
Difficulty uses two columns on wide screens and one on phones; pending/error
handling and future-session semantics are preserved. Expanded dictionary filters
can scroll within their bounded sticky panel; words retain the main scrollport.

POST /training/sessions/preview shares the start planner, all filters, scheduling,
size/all, order, shuffle-prefix eligibility and matching ambiguity checks. Its
response contains only count, selection_seed and nullable unavailable_reason;
no session, item or missing schedule is persisted. Start reuses the preview seed
for selection only; answer options/indices keep independent SystemRandom. No
schema, dependency or external service change. Data edits or due-time crossings
can change eligibility between preview and start; start remains authoritative.
The client hides stale/invalid counts and disables unavailable starts, with retry
for preview failures. Existing start failures remain visible.

Attempt 1 review found enlarged-text dictionary title/button overlap. Attempt 2
adds wrapping toolbar layout, a shorter counter label, table/fieldset/shuffle
width constraints and visible keyboard focus below the pinned panel.

Verification: final make check exit 0, tooling 38 / backend 435 / frontend 198;
formatting, ruff, mypy, lint, typecheck/build pass. Root and reviewer matched all
19 changed code/test files to the gate snapshot. Log SHA256:
6e913ed3a373f9a01b087a38795eb5c1573f49a3a97702dfd5408eaca6d4b688.
New backend tests cover preview/start parity, ambiguity/seed variation, finite
shuffle prefixes, scheduling/new-word cap, filters, read-only behavior, ownership,
CSRF and no-store. Frontend tests cover count requests/seed, late-response races,
invalid/loading/error/retry/empty states and confirmed difficulty values.

Chromium evidence: 21 layout cases (320/390/768/1280, plus 320/390/768 at root
font 200%), 10 count cases including live choice/matching/input start parity,
and 38 keyboard-focus cases with closed/expanded sticky filters. No observed
page exceptions or main horizontal overflow. Root inspected final phone/desktop
and enlarged-text PNGs. Evidence is ignored under .local/ui-review-ui005/.
Independent review: Ship; git diff --check passes. No deployment or production
data mutation. Physical Android/iOS remain unverified. Exact root-session model
metadata was unavailable, so its trailer is omitted; verified implementation
contributors both used gpt-6.1-terra.


## SEC-001 — CI action pinning and runtime dependency remediation (2026-11-13)

Status: accepted. Scope: Dockerfile and CI action references; no application,
lockfile, database, or deployment changes. Six action references are pinned to
verified commit SHA values. uv 0.13.5 addresses GHSA-hq85-5cpj-mr62; pip 26.3
refreshes its vendored urllib3/msgpack/certifi. Only zlib1g is upgraded through
APT, to the Debian DSA-6613-1 fixed package. Preserve UID 10001 and data paths.

Verification: make check exit 0 (tooling 38, backend 435, frontend 198 tests;
format/lint/type/build checks passed). Final Docker build exit 0; isolated smoke
with --network none, --read-only, and temporary /data passed migrations,
/api/health HTTP 200 with no-store, and SPA HTTP 200. Runtime versions verified:
Python 3.14.10, uv 0.13.5, pip 26.3, apt/libapt 3.0.4,
zlib1g 1:1.3.dfsg+really1.3.1-1+deb13u1, vendored urllib3 2.8.0,
msgpack 1.2.4, certifi 2026.10.23. Independent code review: Ship, no findings.

The remaining setuptools 70.3.0 vendor-metadata entry does not provide the
PackageIndex implementation referenced by GHSA-5rjg-fvgr-3xxf; the module is
absent in the final image. No full post-change vulnerability scan is claimed.
Other OS advisories from old local images need individual applicability review;
no unsupported system-library patches were introduced. Next external step:
deploy only after authorization, then verify the deployed image separately.


## BUG-001 — Adversarial regression audit (2026-11-14)

Status: done; attempt 2. Owners: backend-agent (backend code/tests),
frontend-agent (frontend code/tests), root (gate/Git/acceptance), code-reviewer
(independent read-only review).

Outcome and AC: fix concrete reproduced defects without changing the API,
schema or approved training contracts. Each of the three original regressions
failed on the pre-audit commit in an isolated archive and passed after the fixes.

- Malformed non-ASCII X-CSRF-Token caused TypeError/500; it now returns 403 and
  leaves the dictionary unchanged.
- A late mutation 401 from an obsolete session logged out a newly authenticated
  account. API errors now capture their request session generation; current
  session 401 errors still clear authentication.
- Matching discarded conflicts even when a later group could accept them.
  Candidates are reconsidered after a full group of eight. Scheduled due words
  remain ahead of new words; conflicts from a partial due group stay excluded
  when introducing new words to preserve the existing snapshot group format.

Files: backend deps.py/training.py and auth/matching/preview tests;
frontend api.ts/session.ts and session.test.tsx; shared task records.
No schema migration or dependency changes.

Review attempt 1 found a due/new ordering regression in candidate recovery.
It was corrected and covered by two scheduled matching regressions. Final
independent review: Ship, no blocking findings.

Validation: final make check exit 0 — tooling 38, backend 447, frontend 202;
formatting, Ruff, mypy, frontend lint, TypeScript/build passed. git diff --check
passed. Root independently reproduced the original three failures against the pre-audit commit
in a temporary copy; no mutation experiments touched the working tree.

Limitations: bounded source/test audit; physical devices, deployment, live data
and paid providers were not exercised. No claim of exhaustive defect absence.
