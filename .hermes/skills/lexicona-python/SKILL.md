---
name: lexicona-python
description: "Use when implementing Lexicona backend and tests."
version: 0.1.0
author: Lexicona contributors, Hermes Agent
platforms: [linux, macos, windows]
---

# Lexicona Python engineer

## When to use
Реализация backend, migrations, доменных правил, API и тестов. Агент сам пишет код; не просит пользователя реализовать решение. Общение на русском.

## Prerequisites
Читать AGENTS.md, lexicona-workflow/product-contract, активный срез и реальные source/locks. Установки в project uv venv, не runtime Hermes. Единственный назначенный schema/API owner, ограниченные allowed_paths.

## Procedure
1. Для нового поведения/bug написать и реально запустить RED-test; затем minimal GREEN, regression и refactor. Не сначала писать всю реализацию и после неё тесты.
2. Полные type hints; публичные API с краткими Google-style docstrings; comments объясняют why. Простые cohesive модули, specific exceptions, context managers, оправданные зависимости.
3. Все object/bulk/import/export пути owner-scoped. Server cookie+CSRF, password hashing вне event loop. Не доверять user_id/grade/delta клиента. DTO не раскрывают ORM/secret fields.
4. SQLite WAL с per-connection FK/busy timeout, explicit transaction control, one AsyncSession per unit of work. Короткий write lock, никакого сетевого обращения/парсинга/Argon2 под ним. CAS+event+progress+idempotency commit атомарно; file-backed concurrent tests.
5. Percent scoring и SRS раздельны по контракту, server snapshots фиксируют difficulty/policy. Прогресс не выходит за 0–100, повтор item/key не начисляет второй раз, semantic edit reset только после подтверждения.
6. Scoped Ruff fix/format своих файлов; затем read-only Ruff check/format check, mypy --strict, полный relevant pytest с branch coverage и gates workflow. Не скрывать типы через Any/ignore и не исключать трудные ветви ради процента.
7. Проверить миграции fresh/upgrade, actual runtime SQLite, negative security/error/concurrency AC. Непроверенное перечислить not_run/blocker. Handoff координатору с paths/commands/exit codes/рисками, не самостоятельное done.

## Pitfalls
Не делить session между parallel tasks, не использовать memory SQLite вместо WAL race tests, не подменять provider/API fixtures, не писать секреты в argv/logs. Не править чужой frontend/ops/global config без scope, не запускать deployment и не создавать подагентов.

## Verification
Ready for review только после real tests/type/lint/coverage, чтения собственного diff и исполнения каждого AC. Независимый reviewer и координатор принимают интеграцию.
