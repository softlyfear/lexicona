# Архитектура Lexicona

Источник продуктовых требований — приватная `.local/spec.md` и утверждённые требования
в `.local/requirements/`. Этот файл содержит только инженерную карту.

- Backend: FastAPI → routers/deps → доменные функции и SQLAlchemy async → SQLite WAL.
- Миграции Alembic; одна БД, naive UTC. Авторизация cookie, CSRF на мутациях.
- Изоляция по owner_id; чужой объект возвращает 404. API всегда no-store.
- React SPA: TanStack Query, react-router, CSS Modules; сеть только через api.ts.
- Словарь сортируется сервером по allowlist: дата добавления, normalized_headword или
  progress в обе стороны; равенства — id ASC. Поиск q и sort хранятся в URL,
  фильтр training выбирает active/excluded/all; теги фильтруются по OR через повторяемые
  tag_id в API/URL; query key ['words', q, sort, training, tagIds] с sorted/unique ID
  разделяет выдачи, invalidation ['words'] обновляет все порядки и области.
- Один процесс отдаёт API и собранный frontend. Docker + Caddy — целевая поставка.
- PWA: manifest, standalone, any/maskable PNG и apple-touch icon; install.ts сохраняет
  browser install prompt до открытия настроек. Settings вызывает системную установку
  либо показывает инструкции Android/iOS. Service worker/cache storage отсутствуют;
  установка не означает offline-обучение и требует HTTPS за пределами localhost.
- Прогресс — целое >=0 без верхнего clamp 100; content_version защищает от устаревших
  вопросов, повторный ответ
  не должен повторно начислять прогресс. Правильный ответ решает сервер.

Один speech.ts controller с useSyncExternalStore использует voiceschanged/ожидание2с,
language-only fallback, generation token отмены и length/rate watchdog (20с..10мин).
Preferences локальны в lexicona:speech:v1:<user.id> (locale, EN/RU voiceURI, rate1/.75,
autoPrompt default on); EN-US default, недоступность/фактическая замена явно показаны.
Start/Next озвучивают только публичный prompt текущего item, RU→EN — русский,
cloze — masked EN. Ошибка/отказ не меняет обучение; route/hidden/logout/user switch
отменяет pending/active речь; открытие new/edit редактора тоже отменяет речь, сохраняя
изолированный new-редактор. Ручные RU-кнопки читают отдельные переводы, EN — headword.
Backend/схема прежние; voice localService и ограничения
слышимости объясняются, fake/browser проверки отделяются от физических устройств.

Подсказки RU/IPA используют отдельный read-only SQLite индекс pinned FreeDict+WikDict
eng-rus2025.11.23 (CC-BY-SA3.0), вне пользовательской БД. CLI python -m lexicona.dictionary
build проверяет SHA256, ограничивает archive/XML, отклоняет entities/чужие DTD и атомарно
заменяет индекс. Runtime проверяет source manifest/SHA и закрывает каждое соединение.
POST /dictionary/lookup принимает слово в body с auth/CSRF и не записывает raw query в URL;
exact case перед normalized/source ordinal. При matches=[] локально возвращаются до трёх
spelling_suggestions по близости написания (длина ±2); выбор варианта меняет headword и повторяет
lookup. Внешний перевод вызывается в asyncio.to_thread: по умолчанию DeepL Free, при его
сбое/отсутствии ключа — DeepSeek через OpenRouter;
provider=openrouter выбирает его напрямую. Фиксированный HTTPS chat/completions endpoint,
15с DeepL/60с LLM timeout, без redirects, ответ до64KiB и строгий JSON-разбор без duplicate keys.
Модель по умолчанию ~deepseek/deepseek-flash-latest, JSON schema, reasoning отключён.
DeepSeek возвращает 1..3 перевода и сгенерированную US IPA.
Ответ добавляет machine_translation {provider,text,alternatives,transcription}, не связанный
с FreeDict source_refs; форма показывает все варианты и подставляет IPA. Текст уходит DeepL,
а при fallback также OpenRouter. POST /dictionary/example отдельно генерирует через DeepSeek EN-пример и RU-перевод
с теми же auth/CSRF, transport limits и strict JSON; запись происходит только при submit слова.
Таймауты дают безопасный 504 dictionary_timeout/examples_timeout, прочие ошибки — прежний503;
ключ LEXICONA_OPENROUTER_API_KEY хранится только на сервере, Gemini удалён из активного кода.
Append/replace передают до 20 прежних EN-примеров (1..2000 символов) в JSON, просят существенно
изменить ситуацию/грамматику/лексику и используют temperature 0.9; переводы сохраняют temperature 0.
Точный case-insensitive повтор не изменяет поля; replace в UI явно называется «Заменить все примеры».
Качество идиом, IPA и примеров не гарантируется. GET /dictionary/notices хранит raw
COPYING/teiHeader/credits/transformations, API no-store.
Word.source_refs — nullable JSON, migration c83917f0d52a additive; typed source_id/entry_id/
field/value сохраняют происхождение выбранных значений. Omitted PUT сохраняет только
ссылки на оставшиеся точные значения, [] очищает; index для manual save не нужен.
Downgrade при непустых refs отказывается терять provenance. Редактор явно добавляет
переводы, удаляя combining acute и точные дубли после его удаления; wiki-разметка
[[target|label]]/[[label]] очищается в lookup и built-in distractors. Части речи расшифровываются
в UI, headword имеет ручную EN-озвучку. Частотных данных в FreeDict нет, исходный порядок не
выдаётся за популярность. IPA подставляется автоматически из первой записи с транскрипциями. При равном исходном порядке предпочитаются
US-признаки oʊ и ɹ/r/ɚ/ɝ, иначе берётся первый вариант: разметки диалектов в источнике нет,
поэтому fallback не гарантирует американский акцент. IPA-кнопки и notices в форме не показываются;
README и notices API сохраняют атрибуцию. Late responses по-прежнему отбрасываются, а будущий
экспорт переносит refs/notices.
Данные индекса и выбранные производные значения не получают MIT лицензию кода;
ручные записи не помечаются источником автоматически.

Личные tags принадлежат owner и уникальны по NFC/casefold/схлопнутым пробелам,
без подмены ё/е и пунктуации; до 20 тегов на слово, имя 1..80 code points.
WordIn.tags содержит имена, WordOut.tags — id/name; PUT без tags сохраняет связи,
[] снимает все, GET /tags даёт личный справочник. Составные owner-FK word_tags
и additive migration a71b3c9d8201 защищают данные; downgrade при непустых тегах отказывает
без потерь. Правка тегов косметическая для обеих версий и прогресса. GET /tags имеет
query key ['tags']; сохранение слова инвалидирует words и tags. New-редактор сохраняет
изолированный вид, включая поля тегов; нормализация Unicode согласована с backend.

Профиль и смена пароля находятся на /settings, login в шапке ведёт туда. Смена через
POST /auth/change-password требует current_password и CSRF; новый пароль — 12..128
Unicode code points без trim/нормализации. Argon2 работает в thread pool, короткий CAS
по старому hash и живой session атомарно отзывает прежние сессии и создаёт новую cookie/CSRF.
Login записывает сессию только при сохранении проверенного hash, защищая от старой проверки.

Frontend сериализует login/logout/change-password вместе с обработкой ответа. Поздняя
ротация отзывается /logout с её CSRF до следующего login; revision защищает cache.
Один boolean require-explicit-login в sessionStorage запрещает auto-restore после выхода
или неуспешного cleanup даже после reload; снимается только успешным явным входом.
Секретов/слов в storage нет. При утрате ответа /me согласует CSRF, но не подтверждает
смену пароля; UI не заявляет успех без подтверждённого ответа.

Исключение слова из обучения — отдельный is_excluded, не удаление и не автоматическое
действие при 100%. PATCH /words/{id}/training атомарно меняет флаг и увеличивает
training_version только при фактическом переходе, сохраняя progress/content_version.
Новые занятия выбирают активные слова для targets и distractors; items хранят snapshot
word_training_version. Eligibility проверяется в write path: несовпадение поколения или
исключённое слово закрывает открытый item как unavailable без ответа и дельты, включая
после возврата слова. Ранее принятый терминальный результат сохраняется при replay.
UI показывает реальный процент, визуальную шкалу и aria-valuenow ограничивает 100,
а aria-valuetext сообщает фактическое значение.

Действие исключения/возврата находится рядом с edit/delete; статус строки показывается
только для исключённого слова. Сортировка и фильтр обучения размещены в flex/wrap строке.
Создание и редактирование слова открывают отдельный редактор внутри страницы, скрывая
выдачу/фильтры; отмена или успешное сохранение возвращают прежние q/sort/training/tag_id из URL.

SQLite-миграции выполняются в одной BEGIN IMMEDIATE-транзакции с foreign_keys=OFF
только на отдельном соединении миграции; foreign_key_check выполняется до commit,
при дефекте схема/данные/версия откатываются, затем FK включаются. Это сохраняет дочерние
строки при batch-пересоздании words. Downgrade отказывается терять новые состояния
или progress>100; перед обновлением требуется согласованная backup-копия с учётом WAL.

Не переносить слоистую архитектуру бота, Redis и очереди в этот небольшой сервис
без отдельного обоснования. Структура и команды подробно описаны в AGENTS.md.


Учебные режимы choice и input поддерживают EN→RU/RU→EN. Для input ожидаемые строки
и prompt фиксируются при старте; клиент получает допустимые ответы после ответа или
явно запрошенного раскрытия.
Сравнение и TYPED-дельты вычисляет сервер. Запись результата и начисление прогресса —
одна транзакция с CAS для item и проверкой content_version в write path.

Размер занятия — строгий JSON integer >=1 без фиксированной верхней границы
либо literal "all", default 10.
Сервер возвращает максимум запрошенного числа уникальных активных пригодных слов;
all возвращает весь пригодный набор. UI сохраняет requestedSize
только в состоянии экрана и объясняет сокращённый числовой набор через items.length;
для all показывает фактическое количество всех подходящих слов.
Presets 5/10/20/30/50/75/100/125/150 и свободный ввод управляют одним размером.

Targets отбираются по OR личных tag_ids и включительному progress_min/max>=0,
без max100, затем случайно; least-known больше не применяется. Пустые границы
не ограничивают отбор; Python int сравнивается с progress без SQL overflow.
Choice distractors смешивают активные личные слова и до 120 случайных записей pinned dictionary,
загружаемых через asyncio.to_thread; targets остаются строго личными и проходят фильтр. Builtins
не создают Word/progress и не попадают в словарь. Общие смыслы/headword и нормализованные дубли
исключаются, combining acute удаляется. При недоступном индексе остаётся personal-only fallback.
Фильтры действуют при создании snapshots и не проверяются
повторно при ответе; прежние content/training versions и CAS сохраняются. Новая схема
не нужна, all материализует весь пригодный набор в одной транзакции существующего процесса.

Новые choice-сессии имеют ровно6 однозначных вариантов, включая один правильный.
Неоднозначный/недостаточный пул не создаёт неполные задания. При ответе option проверяется
по длине owned snapshot options, поэтому прежние4-option задания продолжают работать.
UI shortcuts ограничены фактической длиной snapshot, новые задания поддерживают1–6.

Matching запускается только EN→RU и использует существующие TrainingItem без новой схемы.
Каждые позиции 0–7, 8–15 и т.д. образуют группу до восьми пар с общим случайным списком
уникальных primary RU-переводов; correct_option хранится отдельно для каждого EN-prompt.
Совпадения normalized headword, primary translation или любого смысла внутри группы исключаются.
Ответ проходит тот же AnswerIn/CHOICE/CAS/version/replay/SRS write path, что и choice; reveal
возвращает correct_option, skip не раскрывает ответ. Группы показываются последовательно
в двух колонках, завершение группы не вызывает API и не начисляет дополнительный прогресс.
Клиент определяет границы группы по длине snapshot options, поддерживая прежние группы
до четырёх пар и последние неполные группы без изменения схемы.

Карточки и cloze удалены из выбора и запуска новых занятий: POST /training/sessions
отклоняет mode=cards/cloze с 422;
answer/reveal/skip и Run сохраняют поддержку legacy snapshots.
Сервер по-прежнему валидирует сочетания mode/direction. Чистая mask_example допускает ровно одно
целое вхождение headword/фразы в личном example_en, учитывая NFC, регистр, whitespace и апострофы,
без морфологии и fuzzy matching. Для ответа используются normalize и TYPED-policy, как в input.

Сохранённые карточки используют server-only snapshot оборота; reveal фиксируется отдельно и не
начисляет прогресс. После раскрытия первая самооценка grade закрывает item через CAS.
Дельты карточек используют CHOICE-policy: again отрицательная, hard 0, good/easy
положительная. Самооценка не является объективным correct и не входит в метрику точности.

TrainingItem.outcome хранит терминальный answered/assisted/skipped/unavailable; NULL — открытый
item, включая исправляемую первую ошибку. В choice/input/legacy cloze первая ошибка применяет
дельту и SRS один раз; последующие ответы имеют delta=0, не меняют SRS, а правильный закрывает item.
answered_at фиксирует первую попытку, CAS разделяет первую и повторные. UI не показывает ответ
или Далее после ошибки до исправления, reveal/skip остаются доступны. Первый правильный ответ,
терминальные reveal/skip и карточная самооценка завершаются по-прежнему. Итог учитывает terminal
outcomes; промежуточные ошибки не добавляются как отдельные завершённые задания.

`srs.py` и one-to-one `WordProgress` хранят отдельное от видимого процента расписание:
stage 0..6, due_at, has_review, last_review_at, счётчики и progress_version. Миграция
b7d42f0e9a61 создаёт начальные строки для существующих слов; TrainingSession.purpose и
TrainingItem.word_progress_version фиксируют назначение занятия и снимок версии SRS.

POST /training/sessions принимает purpose=scheduled|free (default free) и include_new.
Scheduled случайно берёт due, затем максимум 10 новых; пустая выдача — 409 no_scheduled_words.
Free сохраняет прежние фильтры и случайный отбор, не меняя SRS. Только terminal answered
в scheduled применяет grade и интервалы 10 минут либо 1/3/7/14/30/60 дней; assist, skip,
unavailable, reveal и replay расписание не меняют. Смысловая правка сбрасывает SRS и повышает
progress_version; stale межсессионный ответ получает 409 PROGRESS_CHANGED без записи результата.

TRAIN-009 добавляет status/finished_at/requested_size занятия и nullable SET NULL word_id
для сохранения snapshots после удаления слова (миграция e65adf970121). Latest выбирает строго
последнюю owner-сессию по created_at/id, не ищет более старую незавершённую. Это UI/read-модель,
не уникальность всех исполнимых старых сессий. Finish идемпотентен, SQL write guard запрещает
новый эффект в finished. Resume возвращает все public items/state/results, не раскрывая
correct_option/expected_answers неверного открытого ответа. Повреждённый matching latest
возвращает только metadata/resume_error для завершения; удалённые режимы не продолжаются.

AnswerEvent сохраняет immutable первую актуальную объективную попытку unique(item_id)
в одной транзакции с CAS/прогрессом/SRS. Повторное исправление не меняет её correct/delta.
Исторические item/word/session IDs не имеют каскадных FK; owner-FK сохраняет изоляцию.
User.statistics_started_at отмечает границу достоверности, legacy first attempts не бэкфиллятся.
GET /statistics?period=30d|year|all считает московские дни (UTC+3), нулевые дни и all-time
счётчики. Word.progress>=100 означает выученное в этих счётчиках, без исключения из занятий.
