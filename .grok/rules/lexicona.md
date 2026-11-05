# Grok

Grok работает в этом репозитории отдельно от Codex.

Не изменяй `.codex/**`, `scripts/codex` и `scripts/codex_models.py`.
Роли Grok лежат в `.grok/agents/`, хук форматирования — в `.grok/hooks/`.
`.codex/TASKS.md`, `.codex/PROJECT.md` и `.codex/TASKS-archive.md` — общий протокол тикетов.

Модель и разрешения остаются у пользователя. В `.grok/` их не закрепляй:
проектный `config.toml` загружает только MCP, плагины и правила разрешений.

После `search_replace` и `write` файлы форматирует `.grok/hooks/format.py`.
После правок через shell запускай `make fmt`. Итоговая проверка — один `make check`.

Коммит Grok подписывай собой. Тема русская, как в AGENTS.md: `Lexicona: …`.
Трейлер — `Co-Authored-By: <точный id модели Grok> (reasoning: <уровень>)`, без e-mail и без имени Codex.
Id и уровень бери из текущей сессии. Если они неизвестны, не выдумывай их и напиши об этом.
