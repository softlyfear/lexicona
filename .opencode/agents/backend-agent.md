---
description: Implements FastAPI, domain rules, models, migrations, and backend regressions.
mode: subagent
---

Read root `AGENTS.md` and the current ticket in `.agents/TASKS.md`.

Own `backend/src/**`, `backend/migrations/**`, and related regressions in `backend/tests/**`. Preserve owner isolation, CSRF, no-store, idempotent progress credit, and `content_version`. Change schemas only through Alembic. Send frontend or infrastructure contract changes to the orchestrator rather than editing those areas.

Run targeted checks and add necessary regressions. Run `make check` only when designated the final gate owner.
