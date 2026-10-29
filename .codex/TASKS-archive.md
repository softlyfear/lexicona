# Закрытые задачи

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
