---
name: lexicona-linux
description: "Use when building Lexicona Linux deployment."
version: 0.1.0
author: Lexicona contributors, Hermes Agent
platforms: [linux]
---

# Lexicona Linux engineer

## When to use
Разработка/изменение/review Bash, Docker/Compose/Caddy, окружения и recoverable operations. Общение на русском; comments/messages внутри shared scripts на английском.

## Prerequisites
Читать AGENTS.md, lexicona-workflow/product-contract, scope и actual live versions через `terminal`, а не память о машине. Project venv/npm/Docker разрешены; system install/sudo/production/VPN/DNS/SSH/firewall отдельно согласуются. Не менять Hermes runtime.

## Procedure
1. Установить read-only факт current/desired state, target distro/Bash/privileges, invocation и impact. При риске outage/data loss с неизвестным rollback вернуть blocker, не экспериментировать мутациями.
2. Least disruptive idempotent solution: inspect-before-write, required command/path/argument validation, atomic validated config replacement, restrictive backup и concrete restore. Не рестартовать без изменений; reload только если поддерживается безопасно.
3. Executable Bash: shebang, осмысленный set -euo pipefail, two-space indent, local variables, readonly constants, arrays, quoted expansions, printf, mktemp+trap с TMPDIR. Не менять caller options sourced-библиотеки, не eval при безопасной альтернативе.
4. LF/UTF-8 без BOM, pre-activation bash -n/ShellCheck и transfer-artifact checks. Перед high-impact операцией adjacent «⚠️ RISK: consequence. Rollback: concrete recovery.». Без реального recovery не предлагать опасное действие готовым.
5. Containers non-root, pinned versions/digests, только нужные mounts, localhost dev ports, no Docker socket/home/credentials mounts. Docker access не security sandbox. Не prune/down -v чужих ресурсов.
6. SQLite Online Backup, не cp одного live main file в WAL. Шифрованный offsite snapshot, verified delivery/retention/status, restore drill в отдельный volume, revoke recovered auth secrets. Недоступный backup receiver не считать offsite success; RPO/RTO только после измерения.
7. Actual syntax/config/build/smoke/persistence/restore/failure checks с наблюдаемыми success criteria. Логи без secrets/личного содержимого. Handoff facts/assumptions/changes/rollback/commands/exit/not_run; real target external write прочитать обратно.

## Pitfalls
Не принимать --version за проверку приложения; не писать секреты в argv/logs/tracing; не broad recursive rm/chmod/chown; не использовать production как тестовый стенд; не выполнять sudo без пользователя и не менять чужие профили. Не запускать подагентов/фоновых AI-workers.

## Verification
Скрипт и фактическое окружение совпадают, изменения обратимы где применимо, static и runtime AC реально проверены. Не распространять прежние evidence на изменённый candidate без recheck.
