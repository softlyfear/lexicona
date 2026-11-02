# Архитектура Lexicona

Источник продуктовых требований — приватная `.local/spec.md` и утверждённые требования
в `.local/requirements/`. Этот файл содержит только инженерную карту.

- Backend: FastAPI → routers/deps → доменные функции и SQLAlchemy async → SQLite WAL.
- Миграции Alembic; одна БД, naive UTC. Авторизация cookie, CSRF на мутациях.
- Изоляция по owner_id; чужой объект возвращает 404. API всегда no-store.
- React SPA: TanStack Query, react-router, CSS Modules; сеть только через api.ts.
- Словарь сортируется сервером по allowlist: дата добавления, normalized_headword или
  progress в обе стороны; равенства — id ASC. Поиск q и sort хранятся в URL,
  фильтр training выбирает active/excluded/all; теги фильтруются по AND через повторяемые
  tag_id в API/URL; query key ['words', q, sort, training, tagIds] с sorted/unique ID
  разделяет выдачи, invalidation ['words'] обновляет все порядки и области.
- Один процесс отдаёт API и собранный frontend. Docker + Caddy — целевая поставка.
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
POST /dictionary/lookup принимает слово в body с auth/CSRF, не обращается к внешним
сервисам и не записывает raw query в URL; exact case перед normalized/source ordinal.
GET /dictionary/notices хранит raw COPYING/teiHeader/credits/transformations, API no-store.
Word.source_refs — nullable JSON, migration c83917f0d52a additive; typed source_id/entry_id/
field/value сохраняют происхождение выбранных значений. Omitted PUT сохраняет только
ссылки на оставшиеся точные значения, [] очищает; index для manual save не нужен.
Downgrade при непустых refs отказывается терять provenance. Редактор явно добавляет
переводы/выбирает IPA, защищён от late responses; будущий экспорт переносит refs/notices.
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
Создание слова открывает отдельный редактор внутри страницы, скрывая выдачу/фильтры;
отмена или успешное сохранение возвращают прежние q/sort/training из URL.

SQLite-миграции выполняются в одной BEGIN IMMEDIATE-транзакции с foreign_keys=OFF
только на отдельном соединении миграции; foreign_key_check выполняется до commit,
при дефекте схема/данные/версия откатываются, затем FK включаются. Это сохраняет дочерние
строки при batch-пересоздании words. Downgrade отказывается терять новые состояния
или progress>100; перед обновлением требуется согласованная backup-копия с учётом WAL.

Не переносить слоистую архитектуру бота, Redis и очереди в этот небольшой сервис
без отдельного обоснования. Структура и команды подробно описаны в AGENTS.md.


Учебные режимы choice, input и cards поддерживают EN→RU/RU→EN. Для input ожидаемые строки
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

Targets отбираются по AND личных tag_ids и включительному progress_min/max>=0,
без max100, затем случайно; least-known больше не применяется. Пустые границы
не ограничивают отбор; Python int сравнивается с progress без SQL overflow.
Choice distractors берутся из всего активного личного словаря, targets строго из фильтра;
Фильтры действуют при создании snapshots и не проверяются
повторно при ответе; прежние content/training versions и CAS сохраняются. Новая схема
не нужна, all материализует весь пригодный набор в одной транзакции существующего процесса.

Новые choice-сессии имеют ровно6 однозначных вариантов, включая один правильный.
Неоднозначный/недостаточный пул не создаёт неполные задания. При ответе option проверяется
по длине owned snapshot options, поэтому прежние4-option задания продолжают работать.
UI shortcuts ограничены фактической длиной snapshot, новые задания поддерживают1–6.

Cloze работает только EN→EN; сервер валидирует сочетания mode/direction для всех режимов.
Чистая mask_example допускает ровно одно целое вхождение headword/фразы в личном example_en,
учитывая NFC, регистр, whitespace и апострофы, без морфологии и fuzzy matching. Подстроки,
повторы и примыкание к буквам/цифрам/апострофам/дефисам, включая U+2010/U+2011, исключаются.
Полный masked prompt хранится как Text; ожидаемый headword — приватный snapshot до
answer/reveal. Для ответа используются normalize и TYPED-policy, как в input.

Карточки используют server-only snapshot оборота; reveal фиксируется отдельно и не
начисляет прогресс. После раскрытия первая самооценка grade закрывает item через CAS.
Дельты карточек используют CHOICE-policy: again отрицательная, hard 0, good/easy
положительная. Самооценка не является объективным correct и не входит в метрику точности.

TrainingItem.outcome хранит терминальный результат answered/assisted/skipped/unavailable;
NULL — открытый
item. Полное раскрытие в choice/input/cloze закрывает assisted с delta 0; skip закрывает любое
задание с delta 0 без выдачи ответа. Первое терминальное действие выигрывает CAS; answer,
reveal и skip при повторе возвращают фактически сохранённый результат. Штатное карточное
reveal остаётся нетерминальным. Итог занятия считает помощь, пропуски и недоступные отдельно от
самостоятельных правильных/неправильных ответов и самооценок карточек.

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
