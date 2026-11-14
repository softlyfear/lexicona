# Активные задачи

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
Настройки Codex не менять.
TASKS/PROJECT/TASKS-archive — общий проектный протокол обоих агентов, не настройки Codex.

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
