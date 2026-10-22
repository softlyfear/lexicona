# Lexicona backend: foundation, auth CLI и phase2A/phase2B HTTP

Foundation LX-001/LX-002: FastAPI application factory, health endpoints,
файловый SQLite, явные Alembic migrations и локальные quality gates.
LX-003 содержит четыре auth-таблицы, защищённую CLI первого администратора и
восемь настоящих auth/admin операций: csrf, login, register, me, logout,
invite create/list/revoke. Нет дополнительных endpoints или 200/501 заглушек.
Это server-only срез: browser UI аккаунтов/invites, словарь и тренировочные
percentage/SRS policies здесь не реализованы и полный LX-003 не заявлен.

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
Application logger `lexicona.http` пишет только request_id, method, route template
(unknown — `unmatched`), status и duration, без raw URL/body/headers/identity.
Factory подавляет driver DEBUG (`aiosqlite`, `sqlalchemy.engine`); SQL echo выключен,
параметры SQL скрыты. Не включайте raw access/driver logs для auth traffic.
`LEXICONA_DATABASE_URL` переопределяет URL и для приложения, и для Alembic:
поддерживаются только файловые `sqlite+aiosqlite` URL без query parameters.
Запуск приложения **не выполняет миграции**. Неизменённая `0001_foundation`
фиксирует исходную revision boundary. Текущий head `0002_auth_core` создаёт только
`users`, `user_settings`, `auth_sessions`, `invites`; переход с `0001_foundation`
выполняется той же явной командой `alembic upgrade head`.

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
Auth UoW ограничивает busy wait оставшимся единым admission budget и восстанавливает
`busy_timeout=5000` до безопасного reuse соединения.
Выбрана только SQLAlchemy-managed BEGIN policy (`isolation_level=None` у драйвера),
без смешивания с driver `autocommit=False`. Обычный UoW использует `BEGIN`,
`unit_of_work(write=True)` резервирует writer через `BEGIN IMMEDIATE` **до** yield.
Оба варианта откатывают DDL/released savepoint вместе с внешней транзакцией.

При busy write UoW завершается rollback без выполнения application body и без
автоматического retry. Подготовка/хеширование/разбор/сеть должны выполняться **до**
входа в write UoW; финальные проверки состояния и SQL — внутри. Auth mutations
не повторяются автоматически: unknown commit не означает rollback,
не даёт cookie/success и не превращается в secret replay receipt.
Readiness безопасно отвечает 503 при DB lock/ошибке/исчерпании pool и восстанавливает
200 после снятия причины. При обычном WAL writer reader/readiness не блокируются.
Auth имеет один monotonic admission deadline 12 секунд перед parser/hash/DB;
каждое ожидание использует remaining этого deadline. Уже submitted native
BEGIN/write/commit join-ится до rollback/close/pool reuse, в том числе при повторной
отмене. Finalization может выйти за response budget: это не hard syscall SLA.
Известный commit не объявляется rollback, но поздний ответ не получает success/cookie.

## Первый администратор: только локальная защищённая CLI

После явной миграции пустой БД, из `backend/` и в интерактивном терминале:

```sh
.venv/bin/python -m lexicona.operations.admin bootstrap --login admin --display-name 'Администратор'
```

Это пример nonsecret login/name, **не** пароль по умолчанию. CLI дважды запрашивает
пароль через скрытый TTY/getpass; ввод должен точно совпасть. При non-TTY, EOF,
отмене, небезопасном getpass fallback или mismatch запись не начинается. Нет
`--password`, password-file, password environment variable или public bootstrap.
Не передавайте пароль в argv, shell history, перенаправленный stdin или логи.
`LEXICONA_DATABASE_URL` выбирает ту же файловую БД, что приложение и Alembic;
CLI не читает `.env` и не запускает миграции автоматически.

Login: 3–32 ASCII `[a-z0-9_]`, A–Z приводятся к нижнему регистру; пробелы не trim.
Display name: NFC/outer trim, 1–80 символов, без control/surrogate code points.
Пароль: 12–128 Unicode scalar values, без trim/NFC/truncation, включая значимые
пробелы. Длина 12 — продуктовый контракт, не заявление полного OWASP conformity.
Проверка аргументов предшествует password prompt. Любая существующая учётная
запись запрещает первоначальную настройку: это не recovery/elevation команда.

| Exit | Статический результат |
|---|---|
| 0 | `Первый администратор создан.` (stdout, только известный commit) |
| 2 | `Проверьте введённые данные.` |
| 3 | `Логин недоступен.` (приоритет над already bootstrapped) |
| 4 | `Первоначальная настройка уже выполнена.` |
| 5 | `База данных не готова.` (schema/DB/busy/runtime failure) |
| 130 | `Операция отменена.` |

Все отказы идут в stderr без введённых значений, hash, SQL и filesystem paths.
`--help` показывает только справку argparse, не выполняет bootstrap. Hash готовится
до writer lock; fresh `BEGIN IMMEDIATE` повторяет проверки schema/login/пустоты и
атомарно создаёт admin+default settings. При конкурентных запусках выигрывает один;
второй получает 3 для того же canonical login или 4 для другого. Busy/unknown commit
не повторяются автоматически; ошибка/отмена после submitted commit **не** означает
rollback. При неизвестном результате проверьте состояние БД, не считайте exit5
доказательством отсутствия аккаунта.

Argon2id явно задан: version19, 65536KiB, t3, p1, salt16/hash32, UTF-8.
Отдельный executor допускает 2 running и 4 removable FIFO waiters; full admission
отвергается немедленно, queue wait ограничен min(2s, remaining deadline).
Cancelled/expired pending jobs не начинают hash; running permit удерживается до
реального завершения thread, даже если caller отменён. Закрытие сервиса прекращает
admission, убирает pending work и join-ит threads вне event loop. CLI закрывает
executor и DB, дожидаясь cleanup также при повторной coroutine cancellation.
12s deadline относится к стадии create после защищённого ввода, не к времени
размышления оператора; это не hard syscall timeout или готовый HTTP SLA.

HTTP lifespan создаёт один такой service и один случайный dummy PHC вне event loop,
до admission запросов; shutdown join-ит native work, затем закрывает DB. Unknown,
wrong и inactive credentials получают одинаковый 401; real/dummy verify ровно один.

## HTTP auth / identity boundary

Auth routes находятся под `/api/v1/auth`, invites — под `/api/v1/admin`; нужен same-origin cookie client.

| Method / route | Request | Success |
|---|---|---|
| GET csrf | Exact Origin, либо Sec-Fetch-Site same-origin, либо exact-origin Referer | `{csrf_token,authenticated}`; existing session без rotation |
| POST login | P; `{login,password}`; Origin+CSRF+expected anonymous | 200 `{user,csrf_token}`; atomic P→A |
| POST register | P; `{invite_token,login,display_name,password}`; те же unsafe guards | 201 `{user,csrf_token}`; atomic user/settings/consume/P→A |
| GET me | A; no query/body | `{user}` только текущего active user |
| POST logout | A/P; `{}`; Origin+CSRF+expected current principal | `{csrf_token,authenticated:false}`; atomic A/P→P |
| GET /admin/invites | Current active admin; `limit?`, `cursor?` | 200 `{items,next_cursor}`; полный административный список |
| POST /admin/invites | Current active admin; `{}`; unsafe guards | 201 `{invite,invite_token}`; новый invite72h |
| POST /admin/invites/{invite_id}/revoke | Current active admin; `{expected_version}`; unsafe guards | 200 `InviteDTO`; CAS или текущий revoked без изменения |

GET/HEAD body не читается. POST reader принимает фактические ≤16384 bytes,
UTF-8 JSON object, depth≤16, без duplicate keys/non-finite/extra fields и coercion.
Read deadline min(5s, remaining admission); не-JSON/encoded payload — 415.
Query fields и повторы — 422, кроме двух полей invite list ниже. Неподдерживаемые scoped routes/methods
дают безопасные 404/405 (Allow у405), а не placeholders.

У всех scoped application responses, включая errors: `Cache-Control: no-store`,
новый server UUIDv4 `X-Request-ID` и `X-Lexicona-Request-Principal`:
`anonymous` либо `user:<canonical UUIDv4>`. Это authorization decision конкретного
request, не echo и не текущее состояние browser cookie jar. Login success stamp
остаётся anonymous; logout stamp — старый principal. У me stamp совпадает с user.id.
Ошибки: `{error:{code,message,fields,request_id}}`, без input/SQL/exception values;
429/503 имеют Retry-After≥1. Protocol rejects до ASGI не обещают эти app headers.

Unsafe требует `X-CSRF-Token` своей session и
`X-Lexicona-Expected-Principal` captured principal. Missing/duplicate/list/malformed
или mismatch expected →412 `principal_mismatch` после auth/CSRF/state guards,
повторная проверка внутри final write. Нет эффектов, touch или cookie на отказе.
Если Origin присутствует, он authoritative и exact; иначе unsafe требует exact
HTTPS Referer даже в dev. Cross-origin credentialed CORS не включён.

Session: отдельные независимые cookie/CSRF tokens по256 bits, cookie hash-at-rest
SHA-256 decoded bytes. P30min non-sliding; A idle7d/absolute30d; touch CAS не чаще5min.
Login cap5/user сериализован и отзывает oldest `(created_at,id)` из valid sessions.
Production cookie `__Host-lexicona_session`: Secure/HttpOnly/SameSite=Lax/Path=/,
без Domain; explicit dev — `lexicona_session_dev`, без Secure. Max-Age P1800/A2592000,
Expires берётся из persisted absolute timestamp. Reads/touch/errors не пишут cookie.

Process-local limits: general120/IP/60s; P issuance20/IP/60s и global10000 valid P,
cleanup≤500 expired/revoked P; login5 failures/in-flight/account и IP/900s. Fixed
windows не продлеваются blocked attempts, success освобождает только свою reservation;
running native work удерживает reservation до настоящего completion. Maps≤10000,
cleanup≤128/request; account keys keyed digests с ephemeral process secret. Restart
сбрасывает counters. IP — socket peer при обязательном `--no-proxy-headers`.

### Invites и закрытая регистрация

Invite TTL ровно72h; equality уже expired. В БД только SHA-256 decoded32 bytes,
не raw token. Секрет выдаётся только первым known-committed201 создания; list,
revoke, ошибки и retry его не восстанавливают. `InviteDTO` всегда содержит
`id,created_by,created_at,expires_at,used_at,revoked_at,state,version`;
nullable поля присутствуют как null. Нет used_by/login получателя/hash/secret.
Timestamp UTC с шестью микросекундными цифрами и Z, UUID canonical lower-casev4.
State: used, иначе revoked, иначе expired при now>=expires, иначе active;
переход времени version не изменяет.

Список: `(created_at DESC,id DESC)`, `limit` default50/range1..100, только ASCII
`[1-9][0-9]{0,2}` без leading zero/sign/trim. Cursor<=256 — canonical unpadded
base64url компактного UTF-8 JSON `{v:1,created_at_us:integer,id:UUIDv4}` в этом
порядке полей; никакого whitespace/UUID repair, duplicate/extra fields или bool
вместо integer. Следующая страница строго меньше tuple; новых дубликатов при
inserts нет, snapshot consistency между страницами не обещается. Query не
является owner selector. GET body не читается; успешный list использует тот же
throttled5min session touch с повторной current-role проверкой до touch.

Registration: pre-auth+origin+CSRF+expected, bounded parse и dual reservation;
сначала valid invite, только затем duplicate login. Все unknown/expired/used/
revoked invites одинаково400 `invite_invalid`; valid duplicate409
`login_unavailable` с безопасным fields.login, без consume. Argon2 hash готовится
в lifespan-owned2+4 executor вне write lock. Финальный IMMEDIATE заново проверяет
P/time/CSRF/expected и invite/login; user+default settings+conditional invite
consume(version+1)+P revoke+новая A фиксируются одним commit. Два independent P
на один invite дают один201 и один400; fault до known commit откатывает весь UoW.
Hash facade использует существующий generic native submission/completion seam:
reservation не освобождается при одном лишь HTTP timeout/cancel. Алгоритм native
executor/DB finalization не заменён; submitted unknown commit — не rollback.

Revoke сначала сверяет expected_version (strict integer1..9223372036854775807),
потом state. Stale409 `version_conflict`; used/expired409
`invite_state_conflict`; missing404. Active→revoked увеличивает version;
revoked+currentversion200 возвращает прежние данные без эффекта. Current
active/admin/session/CSRF/expected повторяются внутри final write до effects.
Admin authorizes только административные invites, не чужой private vocabulary.

Дополнительные process-local fixed windows: register10 attempts/IP/900s и
5/token-digest/900s, failures/in-flight занимают slots, success снимает только
свой; create10/admin/60s и global100 active invites через serialized count+insert.
Retry-After — ceiling до самого позднего blocking end (включая active-cap expiry).
Новые maps также<=10000, без live eviction, cleanup всех затронутых maps<=128
за request. Старые general120/60, P issuance и login5/900 не заменены.

Нет automatic mutation retry или secret receipt. Потерянный register response:
me→csrf, затем явный login при необходимости, не слепой повтор register. Неизвестен
create outcome: list, явный revoke лишнего и новое создание; token невосстановим.

### Config и test DI

`create_app(database_url=None, *, auth_config=None, clock=utc_now, ids=uuid4,
tokens=token, password_hasher=None, rate_clock=monotonic)` — isolated typed factory.
`AuthConfig(public_origin="http://127.0.0.1:5173", development=True)` — explicit dev
default для same-origin frontend proxy. Production передаёт explicit canonical
HTTPS origin и `development=False`; HTTP/default port/path/userinfo/неcanonical
authority отвергаются. Host/X-Forwarded-* никогда не определяют public origin.
Factory не читает `.env`, не создаёт users и не запускает migrations.

`clock` возвращает aware UTC; `ids` — UUIDv4; `tokens` — canonical43 ASCII из32bytes,
независимый для каждого вызова. `Hasher(hash,verify)` — typed synchronous DI только
для тестов; production default — настоящий ArgonHasher. Executor/lifespan ownership
остаётся у приложения. `rate_clock` monotonic, не источник session UTC.

### Actual OpenAPI: 8 auth/admin + 2 legacy health operations

`openapi/auth-v1.json` экспортируется из **этой** factory, без lifespan/hash/DB
connection, без Hermes/локальной мастерской. Он содержит реальные request/response
DTO, оба identity headers, 412, status/code/message mapping и header presence.
Schema содержит ровно8 auth/admin method+route rows и2 legacy health operations
(9 paths,10 methods), closed DTO и bounded manual request parser metadata.
Четыре phase2B операции включены; дополнительных account/settings routes нет.

```sh
.venv/bin/python -m tools.export_openapi
.venv/bin/python -m tools.export_openapi --check
```

Check только читает artifact и возвращает nonzero при drift/missing file. Генерация
frontend типов принадлежит отдельному tooling/frontend scope; backend не создаёт
`frontend/src/shared/api/generated.ts`. Полный browser account/invites flow остаётся
отдельным срезом, не доказан только этим OpenAPI и backend coverage.

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
.venv/bin/coverage run --concurrency=greenlet,thread -m pytest -q
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

`--concurrency=greenlet,thread` измеряет настоящие SQLAlchemy async→greenlet
continuations вместе с threads. Без него CTracer пропускает строки после await
в greenlet context; это не отсутствие исполнения и не причина добавлять fake hits.
Конфигурация/threshold100 и source gate не ослаблены; исключений нет.

Тесты проверяют реальные online upgrade/re-upgrade/downgrade, offline SQL,
health/error contract, file-backed WAL/FK/busy timeout, commit/rollback,
savepoint semantics и параллельные reader/writer connections. JSON reports,
БД, WAL/SHM/journal files и `.venv` исключены из Git.

Проверки этого среза не заменяют независимое code review, frontend integration,
backup/restore, load testing, deployment или физическую проверку TTS.
