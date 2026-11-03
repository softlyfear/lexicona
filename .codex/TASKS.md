# Активные задачи

Последнее указание пользователя 2026-11-02: Codex и Kimi Code — два независимых агента.
Настройки Codex не менять; Kimi добавляет собственную аналогичную конфигурацию и продолжает MVP.
TASKS/PROJECT/TASKS-archive — общий проектный протокол обоих агентов, не настройки Codex.

Последнее уточнение 2026-11-02: завершить только текущий SRS-тикет и остановиться.
Новые тикеты после SRS не начинать без отдельного запроса. Принятые тикеты — в TASKS-archive.md.

## TRANSLATE-001 — DeepL и Gemini для неизвестных фраз

Статус: acceptance, заблокирован прежним gate. Попытка: 3. Исполнитель и владелец gate: Kimi-оркестратор.
Цель: при пустом локальном lookup предлагать машинный EN→RU перевод через явно настроенный
бесплатный внешний API, не меняя pinned dictionary и личные source_refs.

AC:
1. Settings: translation_provider=deepl|gemini (default deepl), отдельные SecretStr ключи,
   gemini_model default gemini-flash-lite-latest. По умолчанию DeepL, при его сбое или отсутствии
   ключа — Gemini с настроенным ключом; provider=gemini выбирает Gemini напрямую. `.env` и ключи
   не коммитить.
2. Сначала локальный lookup. Только matches=[] вызывает внешнюю цепочку через asyncio.to_thread;
   fixed HTTPS endpoints, Authorization/x-goog-api-key headers, JSON, 15с timeout, запрет redirects,
   bounded 64KiB response и строгий разбор. DeepL api-free /v2/translate target RU source EN;
   Gemini generateContent возвращает 1..3 translations и transcription_us, store не используется.
3. Ответ lookup добавляет nullable machine_translation
   {provider,text,alternatives,transcription}. Внешние значения не получают FreeDict source_ref.
   При сбое local+external сохранить 503 dictionary_unavailable; local matches не отправлять
   наружу. CSRF/auth/no-store и manual save сохранить.
4. WordForm показывает машинные переводы с именем провайдера и короткими кнопками без ударений;
   добавление использует прежние дубли/лимит 10. Выбранные локальные и машинные варианты
   скрываются; US IPA от Gemini подставляется автоматически. Пустой текст показывает empty-state.
5. Мок-тесты обоих providers, запросы/секреты/невалидные ответы, router fallback/auth,
   UI выбор без refs. README/.env.example/PROJECT/TASKS описывают передачу текста выбранному
   сервису и предупреждение Gemini Free о product improvement.
6. Финальный make check, независимый review и mock/live local smoke, коммит/push. Без реальных
   ключей внешний live не объявлять проверенным.

Вне scope: оплата/получение ключей, spellcheck, provider switching в UI, автоматический перевод
существующих слов и гарантия качества идиом.

Проверки попытки 3: live DeepL вернул перевод фразы; live Gemini вернул три перевода и US IPA
для fake it till you make it. make fmt && make check: ruff/mypy зелёные, backend 327/329;
прежние test_scheduled_queue_due_then_at_most_ten_new и test_random_order_is_not_sorted_by_progress
падают на ожидании порядка случайной выборки, их код тикет не меняет. Отдельный полный frontend
format/lint/build и 128 tests зелёные. Независимое ревью дефектов diff не нашло, но вернуло
No-Ship из-за обязательного красного gate. До зелёного gate тикет не закрыт, commit/push не выполнять.
Корневой .env загружается из корня и backend/; оба ключа распознаны. Для цепочки по умолчанию
в локальном .env должно быть LEXICONA_TRANSLATION_PROVIDER=deepl. Локальные :8000/:5173 доступны.

## UX-001 — подсказки и примеры в редакторе

Статус: acceptance, заблокирован прежним gate. Попытка: 2. Владелец: Kimi-оркестратор.
Добавлены ручная EN-озвучка headword, полные названия всех частей речи pinned-индекса, очистка
wiki-разметки `[[target|label]]`/`[[label]]` в lookup и built-in distractors, кнопка примера через
Gemini. POST /dictionary/example защищён auth/CSRF/no-store, использует fixed
HTTPS/timeout/64KiB и strict JSON; значения сохраняются только после submit слова. Новый запуск
cloze удалён из UI и публичного API (422), legacy snapshots и cards сохранены. Live Gemini для
curse вернул EN-пример и RU-перевод. Популярность не выдумывается: FreeDict не содержит frequency
data. Список/пол голосов ограничен Web Speech API браузера и ОС; внешний TTS не добавлялся.
Независимое ревью попытки 1 нашло запуск cloze через API, общий request-id с вечной загрузкой
и неполный POS map; дефекты исправлены. Повторное ревью прервано лимитом 429 после замечания
о postposition/symbol; оба значения добавлены, полный список POS pinned-индекса сверен. Финального
независимого вердикта нет. Проверки: 120 targeted backend, 18 WordForm и все 130 frontend tests,
mypy/typecheck/build зелёные; make check остаётся на прежних двух random-order tests (327/329).

## TRAIN-RETRY-001 — исправление ошибки без повторного штрафа

Статус: acceptance, заблокирован прежним gate. Попытка: 2. Владелец: Kimi-оркестратор.
В choice/input (и legacy cloze) первая ошибка применяет обычную дельту и SRS один раз, оставляет
item открытым; дальшие ошибки и правильное исправление имеют delta=0 и не трогают SRS. Первый
правильный ответ и карточная самооценка завершают item по-прежнему. UI не раскрывает ответ после
ошибки, разрешает повтор и предлагает Далее только после terminal outcome. Схема БД не менялась:
answered_at фиксирует первую попытку, outcome=NULL допускает исправление. Проверки: 120 targeted
backend tests, mypy и все 130 frontend tests зелёные. Независимое ревью первой попытки подтвердило
CAS и отсутствие утечки ответа; повторное финальное ревью прервано лимитом 429. Общий gate красный
на двух прежних random-order tests; commit/push не выполнять.

## Очередь после отдельного нового запроса

1. Восстановление занятия, Idempotency-Key, answer_events; затем matching/passive/listening,
   статистика, подборки/каталог/обмен, аккаунты/темы/PWA/backup/эксплуатация.

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
