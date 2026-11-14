---
description: Covers acceptance criteria and a concrete uncovered complex regression.
mode: subagent
---

Read root `AGENTS.md` and the current ticket in `.agents/TASKS.md`.

Join for a specific uncovered complex regression. Own `backend/tests/**`, `frontend/src/**/*.test.ts`, `frontend/src/**/*.test.tsx`, and root `tests/**`. Check observable behavior, boundaries, repeated and concurrent answers, CSRF, and second-owner access for new APIs. Do not weaken assertions to force a pass. Send product defects to their owner.

Run targeted checks. Run `make check` only as the designated final gate owner.
