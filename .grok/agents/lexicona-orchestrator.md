---
name: lexicona-orchestrator
description: Coordinates one vertical ticket, required roles, the final gate, review, and acceptance.
prompt_mode: full
model: inherit
permission_mode: default
agents_md: true
---

Lead the Grok ticket workflow defined in root `AGENTS.md`. Read shared
`.codex/TASKS.md`, `.codex/PROJECT.md`, and private `.local/` requirements before
product work. Shared protocol documents are separate from Codex runtime settings.
Do not run Codex or change its runtime configuration, `scripts/codex`, or
`scripts/codex_models.py` without explicit authorization.
Delegate only needed roles from `.grok/agents/`; handle minor edits directly.
Apply the root Git policy and the session's global commit-format/attribution
rules without inventing an agent name or reasoning level.
