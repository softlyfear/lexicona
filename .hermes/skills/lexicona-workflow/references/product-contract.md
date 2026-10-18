# Lexicona product contract

Этот документ — переносимые требования к продукту, а не журнал агента. При изменении пользовательских требований обновлять контракт вместе с кодом и тестами. App не требует Hermes у конечных пользователей.

## Product and scope
Многопользовательский личный EN/RU словарь через браузер телефона/планшета/desktop. Русский UI, online-first, без paid APIs. Закрытая регистрация по invite, admin каталог с личным копированием, личные слова/переводы/IPA/примеры/заметки/теги/подборки, поиск/filters/pagination, тренировки/история/статистика, browser TTS, JSON/CSV exchange, light/dark/system, PWA public shell и Docker/backup/restore. Не добавлять платежи, соцсеть, микросервисы, Redis/Celery, обязательный LLM, email или public registration без новой задачи.

## Architecture
Один modular monolith API/worker, SQLite на локальном persistent disk. Python/FastAPI/Pydantic, SQLAlchemy async/aiosqlite, Alembic, uv. React/TypeScript strict/Vite, React Router, TanStack Query in-memory, React Hook Form/Zod, CSS Modules/tokens. Same-origin `/api/v1`, production Caddy/Compose. Exact supported dependency versions и image digests фиксируются проверенными lock-файлами; prerelease/latest плавающие релизные зависимости не использовать. App runtime независим от Hermes Python.

## Accounts and security
- Login `[a-z0-9_]{3,32}` normalized, display name 1–80, password 12–128 без скрытого trim/Unicode normalization. Argon2id вне event loop, bounded concurrency и login rate limits, одинаковая неверная auth error.
- Первый admin создаётся только явной CLI-командой без default password/public bootstrap. Invites TTL72h и recovery30min — high-entropy one-time secrets, hashes at rest, atomic consumption; secret только при выдаче.
- Server sessions token≥256 random bits, hash at rest, production HttpOnly/Secure/SameSite=Lax/Path=/ без Domain; dev cookie отдельно. Idle7d/absolute30d, last_seen не каждый GET, revocation действует сразу. Password change отзывает остальные sessions и ротирует текущую; recovery отзывает прежние.
- Pre-auth/current CSRF в памяти клиента; token+origin validation у unsafe включая login/register/recover/logout. GET не меняет business data. SameSite не единственная защита.
- Server owner-scoping каждого object/join/bulk/import/export/statistic, чужой UUID404; user_id из session. Admin не получает private vocabulary API. Mixed own/foreign bulk атомарно отклоняется. Последний active admin не удаляется/блокируется race-запросом.
- No secrets/body/словаря в общих логах и errors. CSP/text rendering, no arbitrary remote-fetch URL/SSRF, no client auth tokens в persistent storage.

## Vocabulary and consistency
EN expression1–200, основной RU1–200, до10 RU/до10 accepted EN, IPA≤300, examples≤2000 каждый, note≤4000, tags≤20, tag name≤80/collection≤120. Полный aggregate валидирует сервер. Headword не UNIQUE: разные значения допустимы, duplicate warning+explicit confirmation.
Unicode NFC/casefold/whitespace search, RU/EN/note, literal wildcard handling, AND tags, stable allowlisted sorts/tie-break ID, server cursor pages≤100. Лимит20k active words/account configurable.
`content_version` optimistic CAS; stale409. Смысловые поля после явного подтверждения атомарно reset percent+SRS, cosmetic не reset. Soft delete немедленно убирает active выдачу/новые sessions, история snapshot остаётся до account deletion. Collection deletion не удаляет words. Составные owner FK для критичных join tables.
Копирование каталога — личные snapshots, не live shared edits; source provenance dedup, атомарность/idempotency/quota. Источник позже не переписывает личное слово. Два оригинальных demo sets по10, не чужая база.

## Visible progress and difficulty
Основной видимый progress integer0–100, initial0, clamp. «Выучено»=100 индикатора, не вероятность знания и не CEFR. Difficulty personal/synced, default medium. Дельты choice+/choice−/typed+/typed−/passive+:
- very_easy: 10, -10, 20, -10, 5.
- easy: 7, -7, 14, -7, 3.
- medium: 4, -4, 8, -4, 2.
- hard: 3, -3, 6, -3, 1.
- very_hard: 2, -2, 4, -2, 1.
Objective choice/matching использует choice; input/cloze/dictation typed. Cards self-grade again=choice error, hard0, good/easy=choice success, в accuracy не объективный ответ. Help/skip/network/TTS failure0 без штрафа/advancement. Card reveal штатный, objective reveal server-side help.
Practice может менять percent, но не SRS. На word/session один процентный effect; retries/new key к terminal item не накручивают. Смена difficulty влияет на новые snapshots, не ретроактивный пересчёт. Сервер вычисляет дельту по сохранённой policy/version, event+progress+terminal item/CAS одним commit.

## SRS and modes
SRS — внутреннее расписание независимо от percent. Stage0..6, good+1/easy+2 capped6; intervals1/3/7/14/30/60×24h; again stage0 due+10min, hard same stage due+24h. Server UTC time, одна карточка/одно расписание для направлений. Scheduled due before new, max10new default, session10/20/30unique words, TTL24h. Practice/help/skip/passive не двигают due/stage/streak/scheduled counters. Процент100 не отменяет будущего повторения.
Десять UI-вариантов: cards с обоими направлениями; choice EN→RU; choice RU→EN; matching; input RU→EN; input EN→RU; cloze EN example; passive EN→RU; passive RU→EN; EN→EN dictation. Canonical mode/direction combos: cards(en_ru/ru_en), choice(en_ru/ru_en), matching(en_ru), input(en_ru/ru_en), cloze(en_en), passive(en_ru/ru_en), listening(en_en).
Choice:1correct+3unique distractors из той же own области, без accepted-answer overlaps; не хватает — unavailable, не чужие слова. Matching до4однозначных пар; первый выбор source word — terminal score, исправление без второго effect. Cloze только из реально подходящего примера, snapshot скрывает ответ; неподходящий пример не штраф.
Answer normalizer: NFC, trim/collapse whitespace, casefold, typographic apostrophes, RU ё/е, отсутствие одной финальной точки. Не убирать отрицание/артикли, не fuzzy/LLM judge.
Passive: user gesture, обе реплики успешно завершены, затем server ack; replay0, cancel/error/watchdog0, нет объективной accuracy или SRS promotion. Browser completion не защищённое доказательство знания. Dictation — отдельный typed objective mode.
Idempotency same owner/op/key+same payload возвращает прежний receipt; different payload409, terminal item new key409, CAS conflict409 content/progress. Replay после expiry работает до отказа по сроку, auth/CSRF не обходит. Успех только после commit; reconnect retry тем же ключом. Reload восстанавливает server session. Нет success по optimistic UI.

## Speech, themes, accessibility and cache
Browser speech adapter EN-US/EN-GB/RU-RU, voiceschanged, missing/error/bounded loading/watchdog, cancel before new, stop on background/logout/route change. Rate1.0/0.75. Locale/rate sync, concrete voiceURI device-local. Remote voice privacy явно видна, нет скрытого paid/server fallback. Physical TTS проверяется отдельно от mocks/WebKit emulation.
Первая тема — собственная Hermes-inspired graphite/navy с gold/amber и тёплым текстом, без чужого брендинга; semantic CSS variables и расширяемые presets. Light/dark/system. 320px critical flows, 44px touch targets, keyboard/focus/dialog return/labels, AA contrast/reduced motion/zoom.
PWA SW только allowlisted public versioned assets/offline shell. Private API/downloads/auth no-store и не Cache Storage/IndexedDB/localStorage/persisted Query. Query keys user-scoped; logout/401 очищает память, auth revision игнорирует late A response у B; cross-tab logout и bfcache/back boundary.

## Suggestions and exchange
При вводе EN предложить несколько RU для явного выбора, без перезаписи ручного ввода/normalized duplicates/превышения10. Debounce/cancel/stale/auth-revision/loading/empty/error, ручной путь всегда работает. Реальный бесплатный EN/RU source проверять на coverage/license/атрибуцию/redistribution/ranking; dictionary order не называть измеренной популярностью. Предпочтителен локальный licensed lookup; внешний ввод/условия согласовать отдельно, не отправлять личный словарь/секреты и не держать write transaction во время сети.
JSON versioned lossless vocabulary; account JSON дополнительно settings/progress/history, никогда auth secrets. CSV UTF-8/comma/quotes, BOM read, tags JSON array, один основной перевод; UI объясняет потери, safe formula-prefix export. Import≤5MiB/1000rows с actual streamed limit, preview owner/TTL30min immutable/без записи словаря; confirm selected rows/policy/hash; atomic idempotent commit/quota/replay. Нельзя owner/admin IDs/remote URL. Личный Excel переносится по реальному sample отдельной безопасной конвертацией либо явно принятой XLSX-функцией; макросы не запускать.

## Statistics and operations
UTC history/due, IANA user timezone и DST-aware local days. Current vocabulary vs historical activity раздельно; scheduled/practice, objective/self-assessment/help/skip/passive разные категории, empty denominator не фиктивная accuracy. Activity30days, duplicate event не увеличивает counters.
Dev только localhost, системные изменения отдельно. Production1server2vCPU/2GiB/SSD target, 30accounts/50kwords/10VUs/≥5min, p95normal reads/answers≤500ms — измеряемые цели, не готовый benchmark. SQLite actual WAL/security/runtime/transact semantics проверять, one worker/bounded pool/FK/busy timeout/short writes.
Migrations one explicit command; tested backup→maintenance→migration→ready/smoke, rollback compatible code+copy. Online Backup API, шифрованная offsite copy на ноутбук оператора,7daily+4weekly, undelivered не success, isolated restore+integrity/FK/schema/data/auth revocation. RPO24h/RTO2h подтверждаются drill. Minimal health/log rotation/DB-WAL-disk/backup status, без обязательного Prometheus/Grafana. CI после MVP, локальные gates с первого среза. Deployment/VPN/DNS/SSH/firewall/production credentials не входят в общее Git разрешение.
