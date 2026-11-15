# Активные задачи

## Manual feedback queue — 2026-11-14

Source: user screenshots 1–13 and the implementation plan in the current session.
No deployment or historical data fabrication is authorized.
User follow-up: after this queue is complete, remove closed-ticket records and
TASKS-archive.md, keeping history in Git and only current engineering decisions
in PROJECT.md. Preserve active-ticket workflow/template without stale archive links.

- FEEDBACK-001 / accurate first-attempt session summary / accepted / attempt 1.
  AC: corrected retries retain their first error; errors survive reveal/skip;
  resume and matching agree; unknown legacy accuracy is not invented; terminal
  completion categories remain separate from first-attempt accuracy.
  Owners: backend-agent for owner-scoped result contract and behavioral tests;
  frontend-agent for API types, summary and client regressions (final gate owner).
  Check: targeted tests, make check, independent code-reviewer, orchestrator acceptance.
  Evidence: backend targeted 121 and frontend targeted 68 passed; final make check
  exit 0 (tooling 20 / backend 480 / frontend 252), lint/type/build passed.
  No browser visual check. GET /training/sessions/{id}/summary supplies authoritative
  completion and first-attempt counts; hints may precede the first submission.
  Independent code-reviewer: Ship. Orchestrator accepted; no historical data repair.
- FEEDBACK-002 / answer-specific apostrophe and hyphen-space tolerance / accepted / attempt 1.
  AC: accept youre/you're and low life/low-life without fuzzy spelling or changing
  headword uniqueness; preserve hints, one-time scoring and meaningful negations.
  Owner: backend-agent; files: domain/normalize.py, training router and related
  backend tests only. Gate owner: backend-agent. Check: focused domain/API tests,
  make check and independent code-reviewer.
  Evidence: targeted 155 passed; make check exit 0 (tooling 20 / backend 523 /
  frontend 252), formatting/lint/types/build passed. Answer-only policy keeps
  storage normalization unchanged; lowlife is not low-life and can't is not can.
  Independent code-reviewer: Ship. Orchestrator accepted.
- FEEDBACK-003 / prominent revealed answer, playback, nearby Next / accepted / attempt 1.
  AC: authorized answer only, correct speech language, cancellation and compact
  responsive keyboard-accessible controls; failures never affect progress.
  Owner/final gate: frontend-agent. Boundaries: TrainingPage, MatchingRun if needed,
  pages.module.css, focused speech/input/assistance tests. Existing speech
  controller reused; backend changes require a demonstrated missing field.
  Checks: focused behavioral tests, make check, independent review.
  Evidence: targeted 69 passed; final make check exit 0 (tooling 20 / backend
  523 / frontend 267), format/lint/types/build passed. Orca browser fixture
  inspected at desktop 1323x937 and mobile 390x844: answer, playback and adjacent
  Next visible without overflow. No real provider/audio verification.
  Independent code-reviewer: Ship. Orchestrator accepted.
- FEEDBACK-004 / filtered dictionary count / accepted / attempt 1.
  AC: right-aligned count reflects search/scope/OR-tags, zero, loading and mutations.
  Owner/final gate: frontend-agent. Files: WordsPage.tsx, pages.module.css,
  WordsPage tests. Use full response length only after verifying no pagination.
  Hide stale counts for deferred search, placeholder data, fetching and errors.
  Check focused tests, make check and independent review.
  Evidence: WordsPage 53 passed; make check exit 0 (tooling 20 / backend 523 /
  frontend 282), format/lint/types/build passed. Backend list is unpaginated.
  Browser fixture smoke: desktop/mobile long tags, native Enter/Space, count
  2→1→0 passed. Independent code-reviewer: Ship; orchestrator accepted.
- FEEDBACK-005 / persisted optional automatic next / accepted / attempt 1.
  AC: default off; confirmed correct including retry advances once after feedback;
  speech coordination and timer cancellation; no auto-next on reveal/error/skip;
  matching retains group completion semantics; older preferences remain valid.
  Architect checkpoint: independent preferences.training_auto_advance boolean
  (absent false) avoids full training-section overwrite from setup. Existing
  settings endpoint/CAS, no migration. speech controller exposes busy rather
  than parsing status; wait for 1.5s feedback and speech idle, retaining watchdog.
  Owners: backend-agent for preferences/auth/tests, then frontend-agent for DTO,
  account preference write, Settings/App/Run/MatchingRun/speech and regressions.
  Frontend final gate owner; focused tests, make check and independent review.
  Evidence: backend focused 42 and frontend focused 93 passed; final make check
  exit 0 (tooling 20 / backend 553 / frontend 318), format/lint/types/build passed.
  No real audio verification.
  Independent review: Ship. Browser fixture smoke: checkbox default-off→on,
  resume input session, correct answer→exactly next item (2/3), no-voice status
  does not block the flow. Orchestrator accepted; no real API/audio claims.
- FEEDBACK-006 / independent transcription draft / accepted / attempt 1.
  AC: compact IPA-only button; existing translations untouched; explicit Save;
  stale-response protection, provenance, auth/CSRF/no-store and failure tests.
  Owners: backend-agent (dictionary router + transcription/provider tests), then
  frontend-agent (api/WordForm/CSS/tests, final gate owner). Reuse transcribe
  provider operation; explicit IPA-only endpoint, no translation side effects.
  Protect late responses after headword/manual IPA changes, navigation and owner
  changes; no auto-save or generated FreeDict attribution.
  Checks: focused tests, make check, independent review and fixture UI smoke.
  Evidence: backend targeted 64 and frontend targeted 144 passed; make check
  exit 0 (tooling 20 / backend 575 / frontend 337), format/lint/types/build passed.
  Backend stage completed by orchestrator after agent quota; no real provider call.
  Mobile fixture smoke add/edit: keyboard Enter adds only IPA, save calls 0,
  width/scrollWidth 390; translation and note preserved. Independent Ship;
  orchestrator accepted.
- FEEDBACK-007 / AI translation drafts in add/edit / accepted / attempt 1.
  AC: explicit existing OpenRouter provider; request 3–5 common distinct meanings
  but allow fewer; no verified-frequency claim; preserve manual translations;
  no automatic save; bounded validated output and stale/error/isolation tests.
  Owners: backend-agent for translation provider/router/tests, frontend-agent for
  shared WordForm/API/tests; frontend final gate owner. Explicit POST
  /dictionary/translations bypasses local dictionary and DeepL, returns provider
  openrouter and 1–5 distinct meanings. Request 3–5 common senses but never invent
  senses for quota. Enforce existing per-translation max 200 and form max 10.
  Preserve manual entries/provenance; merge latest draft values without silent
  truncation, show limits and estimated AI ordering. No auto-save.
  Check errors/timeouts/malformed output, owner/CSRF, manual/headword/session/
  lookup races, make check, independent review and add/edit fixture smoke.
  Evidence: backend focused 103 and frontend focused 181 passed; final make check
  exit 0 (tooling 20 / backend 614 / frontend 374), format/lint/types/build passed.
  No real paid requests. Shared form preserves latest manual values/provenance;
  near the ten-translation limit, explicit choices replace silent truncation.
  Browser fixture add/edit390px: real Enter, preserved manual values/order,
  IPA/note unchanged, save calls0. At8entries+5suggestions text stays untouched;
  two explicit choices fill10 and remaining choices disable, no overflow.
  Independent reviewer: Ship. Orchestrator accepted. All product feedback is done.
- UBUNTU-001 / duplicate Flatpak Chrome launcher instructions / accepted / attempt 1.
  New user report: README icon script creates a second desktop entry and leaves
  the old iconless launcher. Independent documentation-only slice, disjoint from
  FEEDBACK-006/007 product files.
  Owner: devops-agent, README.md only (no host or user-profile mutations).
  AC: stop guessing the most recent Chrome icon/app ID; repair a specifically
  identified existing launcher instead of blindly creating another; explain safe
  diagnosis and reversible explicit handling of the obsolete duplicate without
  deleting another Chrome app/profile. Do not run pkill or alter real launchers.
  Verify commands against current primary Flatpak/freedesktop documentation and
  isolated temporary fixtures; no new helper/dependency unless necessary.
  Checks: content/command validation, independent reviewer; orchestrator Git.
  Evidence: README shell blocks bash -n passed; temp fixtures cover distinct
  apps/profiles, duplicates, exported symlinks, spaces and non-default XDG paths.
  Orchestrator separately confirmed the two actual launchers share app/profile,
  moved only the iconless duplicate to a restorable state-directory backup,
  refreshed desktop database and verified exactly one themed-icon entry remains.
  No host-specific app ID or path was copied into tracked documentation.
  Independent reviewer: Ship. Orchestrator independently checked shell syntax
  and official Flatpak filesystem permission syntax; accepted.

Delivery order: 001 → 002 → 003 → 004 → 005 → 006 → 007.
Each ticket receives exact file boundaries, evidence, review and acceptance before
the next implementation ticket. Existing work must remain untouched.

NAV-001 accepted and archived (2026-11-14): Lexicona and Dictionary links
return from add/edit forms to the dictionary list even on same-URL navigation,
without saving drafts or dropping dictionary filters. Native link behavior
is preserved. Independent Ship. `make check` exit 0: tooling 20 / backend 463 /
frontend 244. No deployment or browser visual check.

UNIQUE-002 accepted and archived (2026-11-14): requesting translation now
shows an existing-word/phrase warning near the headword, without waiting for
translation or Add. Exact normalized owner matches include learned/excluded
rows; stale responses are ignored and unchanged edited words stay editable.
Independent Ship. `make check` exit 0: tooling 20 / backend 463 / frontend 232.
No deployment or browser visual check.

SPEECH-006 accepted (2026-11-14): server speech is Kokoro only. Piper is
removed from the app, image, and client. The Kokoro interpreter is installed
under /opt/uv-python so the container user can run it. Russian stays in the
browser. A saved Piper voice id does not drop the speech section; synthesis
of that id is rejected. Models stay a separate download. Independent Ship.
Combined make check exit 0: tooling 38 / backend 463 / frontend 221.
No deployment. The full application image was not rebuilt. The screen was
not opened in a browser.

UNIQUE-001 accepted (2026-11-14): the word form rejects a duplicate normalized
headword for a single word and a multi-word phrase, including a learned or
excluded row. A shorter word stays allowed. A note on an existing duplicate
still saves, and cancel during the check does not save. Independent Ship.
Combined make check exit 0: tooling 38 / backend 463 / frontend 221.
No deployment. The screen was not opened in a browser.

TRAIN-LEARNED accepted (2026-11-14): the training filter «Перемешать» is smaller
and sits beside «Выученные». When that toggle is on, words marked learned join
the same sample; tags, progress bounds, order, size, purpose, and shuffle still
apply. Excluded words stay out. Only a session that opted in can score those
words. The choice is stored with the other training settings, and older
preference documents without the field stay valid. Independent Ship. make check
exit 0: tooling 38 / backend 473 / frontend 219. No deployment. The screen was
not opened in a browser.

TRAIN-EDIT accepted (2026-11-14): during a training item, a small edit control
on the right of the prompt opens the existing word form. Matching puts the same
control beside each English word, not inside its button. Public items include
the owner's word_id, or null after deletion. The open question stays the
snapshot. Independent Ship. make check exit 0: tooling 38 / backend 470 /
frontend 218. No deployment. The screen was not opened in a browser.

PREFS-001 accepted (2026-11-14): training setup and speech choices are stored
on the account and restored on the next visit. Overlapping section writes merge
through preferences_revision and do not write a difficulty the request did not
set. Independent Ship. make check exit 0: tooling 38 / backend 469 / frontend 212.
No deployment. Dictionary filters and the PWA install prompt stay on the device.

SPEECH-005 accepted and archived (2026-11-14), attempt 1: all 28 English Kokoro
voices exposed with stable IDs and defaults. Task-only snapshot make check exit 0:
tooling 38 / backend 465 / frontend 203. All 28 real API WAV checks passed.
Local test server uses that snapshot while unrelated preference-sync work remains
unfinished; the shared dirty tree has 23 backend test failures. Independent Ship
applies to this task's verified snapshot.

SPEECH-004 accepted and archived (2026-11-14), attempt 1: optional local
Kokoro-82M CPU runtime with isolated Python 3.13, four US/GB voices and an
isolated test account/database. Independent Ship. Final make check exit 0:
tooling 38 / backend 467 / frontend 211. Real WAV/API and timeout recovery passed.
No VPS or Docker changes; listening quality remains a user assessment.

TRANSLATE-003 accepted (2026-11-14): a dictionary hit with no pronunciation, and a
DeepL translation without IPA, now receive US IPA for the whole phrase.
Dictionary translations stay; the generated IPA is not a FreeDict source ref.
Independent Ship. make check exit 0: tooling 38 / backend 457 / frontend 203.
No deployment.

BUG-001 accepted and archived (2026-11-14), attempt 2: reject malformed CSRF
headers, preserve the current login after obsolete 401 errors, and recover
matching candidates across complete groups while preserving due-before-new.
Independent Ship; final make check exit 0: tooling 38 / backend 447 / frontend 202.
No deployment or live data changes. Audit is bounded, not proof of no other bugs.

Instruction maintenance (2026-11-13): translated the six native role prompts while retaining models, file ownership and the ticket pipeline; restricted shared-record updates to change-authorizing requests. Native metadata, TOML and 38 tooling tests passed. Independent static review passed under the user-approved verification scope; no product or deployment changes.


SEC-001 accepted and archived (2026-11-13): pin six CI Actions and remediate
runtime tooling/vendor dependencies and zlib. Independent Ship; make check
exit 0: tooling 38 / backend 435 / frontend 198. Final image build and isolated
non-root migration/API/SPA smoke passed. No deployment. Remaining OS findings
outside targeted patches are not declared resolved.

2026-11-11: Caddy в compose.yaml публикуется только на 0.0.0.0, чтобы включение IPv6 у мостов Docker не открыло тот же порт на [::]. UFW этот опубликованный порт не фильтрует: правило ставит цепочка DOCKER. Активных тикетов нет.

UI-005 accepted and archived (2026-11-11), attempt 2: sticky dictionary controls,
compact difficulty selection and server-derived training count. Independent Ship;
final make check exit 0: tooling 38 / backend 435 / frontend 198. No deployment.

UI-004 accepted and archived (2026-11-11), attempt 2: compact responsive dictionary,
35 Chromium layout cases, live API action/training smoke checks, independent Ship.
Final make check: exit 0, tooling 30 / backend 422 / frontend 193. No deployment.

Последнее указание пользователя 2026-11-04: завершить DeepSeek через OpenRouter вместо Gemini,
продолжение занятий, график повторений, установка на телефонах/планшетах и больше голосов TTS.
Дополнительные упражнения, подборки/каталог, импорт/экспорт, темы, регистрация/удаление аккаунта
и серверные бэкапы исключены из текущего объёма; аккаунты создаёт владелец.
Настройки OpenCode — `opencode.jsonc` и `.opencode/`.
TASKS/PROJECT/TASKS-archive — общий проектный протокол, не runtime-настройки.

PWA-001 принят и перенесён в TASKS-archive.md:
root make check 17 / 341 / 144, независимое Ship, Chromium installability без ошибок.
Физическая установка Android/iOS проверяется после согласованного HTTPS-размещения.

TRANSLATE-002 завершён: после замены ключа пользователем root подтвердил реальные запросы
OpenRouter выбранного latest-router: пример1.41с, перевод/IPA0.59с — PASS. Секрет не выводился.
Независимое Ship для кода и gate17/351/146 сохранены; детали в TASKS-archive.md.

TRAIN-009 (включая STATS-001) принят и перенесён в архив: gate17/360/157, независимое Ship,
Chromium smoke PASS. Локальная БД обновлена Alembic e65adf970121 с сохранением всех прежних
строк; integrity/FK проверки успешны, старые первые ответы не выдуманы. Backend запущен.

SPEECH-002 принят и перенесён в архив:10 установленных CPU-голосов, финальный gate17/382/167,
независимый Ship после исправления legacy locale, реальные WAV/Chromium PASS.
Полный Docker build PASS: lexicona-speech-local-check (ae0b00eb6033); в итоговом образе без
сети проверены модуль, manifest и настоящий WAV. Локальное приложение запущено на8000/5173.

Активных тикетов нет. SPEECH-003 принят и перенесён в TASKS-archive.md.
Итоговый срез: галочки языков, установка одной кнопкой, график статистики,
кэш Piper и README. Gate make check exit 0 (23 / 383 / 173), независимое Ship.
Следующий внешний этап — согласовать домен/HTTPS/порты и проверить установку/озвучку
на физических Android/iOS. VPS ещё не менялся; исключённые пользователем функции не открывать.

Пользователь ответил на все 13 уточнений. Ключ добавлен как OPEN_ROUTER;
root переименовал его в LEXICONA_OPENROUTER_API_KEY без вывода значения.
Architect подтвердил необходимость immutable first-attempt history (старые retries её
перезаписывали), сохранения snapshot items при удалении слова и SQL-guard статуса занятия
в start/finish/answer. Нельзя выдавать legacy итоговую правильность за первую попытку.
Детальный архитектурный handoff сохранён приватно в
.local/research/resume-architecture-2026-11-03.md; текущий scope —
.local/requirements/approved-scope-2026-11-03.md.

Все перечисленные срезы проходят только нужных исполнителей с тестами, один итоговый gate,
независимое review и приёмку оркестратором. Architect/tests-agent подключаются при
конкретной необходимости. Текущие запросы не разрешают деплой/VPS или force push; Git только root.

Один тикет — законченный вертикальный срез.
Статусы: planned → implementation → review → acceptance → done.
Попытка увеличивается при возврате на доработку.

## Шаблон тикета

ID / цель / статус / попытка / AC / вне scope / файлы и владельцы /
контракты / цепочка / проверки и результат / ревью / приёмка / ограничения.

## Внешнее решение

История пересоздана локально. Force push новой main в GitHub не выполняется
до отдельного явного разрешения пользователя; origin сохранён.
