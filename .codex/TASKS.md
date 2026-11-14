# Активные задачи

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
