---
name: lexicona-frontend
description: "Use when building Lexicona UI and browser tests."
version: 0.1.0
author: Lexicona contributors, Hermes Agent
platforms: [linux, macos, windows]
---

# Lexicona frontend engineer

## When to use
React/TypeScript UI, формы, speech adapter, темы, доступность, PWA и frontend/E2E tests. Общение на русском. Локальный макет — только reference, не готовый продукт.

## Prerequisites
Читать AGENTS.md, lexicona-workflow/product-contract, actual API/schema и locks. Одно направление стилей CSS Modules+semantic tokens, одна forms/schema система, Query для server state. Не устанавливать глобальные packages.

## Procedure
1. Проверяемое поведение/bug сначала RED-test, затем реализация и regression. Реальные API endpoint contracts; mocks только для unit/error boundary, не вместо работающего backend.
2. Dictionary-first плотный список word/IPA/translations/speech/progress; focused training. Телефон/планшет/desktop, 320px critical flows без page horizontal overflow, 44px targets, keyboard/focus/labels/modal return, AA contrast, reduced motion.
3. Тёмная graphite/navy+gold/amber тема в духе Hermes, light/dark/system через tokens; добавление будущих presets не должно менять компоненты. Не копировать логотипы/чужие данные.
4. No false save: ждать server commit; ошибка не стирает форму. User-scoped query keys, cancellation+auth revision, немедленная очистка logout/401 и cross-tab notification. Late response A никогда не попадает в UI/cache B.
5. Speech: feature detection, voiceschanged/bounded loading, EN/RU matching, per-browser voice choice, user gesture, cancel previous, start/end/error/watchdog cleanup. Нет голоса/сбой не ломает текстовые режимы. Passive completion не начислять повторно; TTS mock не доказательство звука.
6. Service worker allowlist публичных assets; никаких приватных API/слов/ответов/auth tokens в localStorage/IndexedDB/Cache Storage/persisted Query. Offline состояние честно unsaved.
7. Strict TS, scoped lint/format, Vitest+coverage по workflow, production build, relevant Playwright against real API, responsive/keyboard/contrast checks. Отчёт actual commands/exit/evidence/not_run. Не самостоятельное acceptance.

## Pitfalls
Не переписывать server normalization/scoring как другой источник истины, не показывать correct IDs заранее, не называть процент вероятностью знания. Demo suggestions явно демонстрационные; реальный lookup требует source/license/ranking. Не использовать личный browser profile/third-party analytics/paid TTS без разрешения.

## Verification
Рабочий пользовательский путь, negative/network/cache cases и реальная сборка, затем независимое review. Physical device/TTS matrix отдельно от engine emulation.
