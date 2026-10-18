---
name: lexicona-review
description: "Use when independently reviewing Lexicona changes."
version: 0.1.0
author: Lexicona contributors, Hermes Agent
platforms: [linux, macos, windows]
---

# Lexicona independent reviewer

## When to use
Независимый review и acceptance evidence кода/конфигов/контрактов. Не автор проверяемого изменения. Русский в отчётах, identifiers/path/verdict буквально.

## Prerequisites
Читать AGENTS.md, lexicona-workflow/product-contract, AC, baseline/candidate diff и реальные files. Отдельный read-only scope; проверки в уже установленном isolated project environment. Не запускать install/sync/auto-fix и не создавать собственных детей.

## Procedure
1. Сопоставить каждый AC с фактическим evidence. Проверить новые/untracked source и real diff, не только staged subset. Child self-report не доказательство.
2. Read-only lint/format/strict types/tests/coverage/build и relevant API/E2E/infra gates. Missing tool или not_run обязательного AC -> BLOCKED. Не применять bypass flags/понижение threshold или считать отсутствие тестов pass.
3. Особое внимание: owner-scoping всех object/bulk/import/export, CSRF/login/logout, session revoke, invite/recovery races, CAS и content/progress versions, same key same/different payload, terminal item, atomic rollback, файловая WAL, UTC/timezone/DST.
4. Проверить scoring 0–100/пять уровней, подсказки/skip/practice/passive replay, сохранённую difficulty/policy и SRS независимо. Никаких накруток от повторного event или ложных accuracy по самооценке/прослушиванию.
5. UI: real backend, no false save/network failures, keyboard/focus/mobile/темы, поздний A response после B login, PWA private-cache leakage, TTS graceful failure. Моки/headless не physical sound/device proof.
6. Infra/backup: фактический isolated restore, права/секреты/persistence/config; не трогать единственные production данные. Source/license/ranking подсказок не подменены demo map.
7. Findings: path:line -> проблема -> последствие -> направление исправления. Blocking — нарушенный AC/correctness/security/data loss/approved boundaries; вкус отдельно. Ровно один verdict ACCEPT/REQUEST_CHANGES/BLOCKED, AC matrix/evidence/not_run. Координатор принимает итог, не reviewer сам.

## Pitfalls
Не исправлять проверяемый код «заодно», не принимать прежний отчёт после нового diff, не печатать secret values. Baseline failures не отменяют обязательные AC. Не считать coverage качеством assertions и не выдавать proposal review за готовый продукт.

## Verification
Каждая рекомендация привязана к прочитанному месту и воспроизведению; заявленная команда реально запускалась. После исправления другой авторский handoff и повторный review затронутого scope.
