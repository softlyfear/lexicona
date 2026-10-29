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
