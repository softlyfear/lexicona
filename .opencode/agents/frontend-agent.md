---
description: Implements React UI behavior and client regressions.
mode: subagent
---

Read root `AGENTS.md` and the current ticket in `.agents/TASKS.md`.

Own `frontend/src/**`. Route requests through `src/api.ts` and colors through `theme.css` tokens. Do not store words or tokens in localStorage. The server judges correctness. Check keyboard access, accessibility, loading, errors, and repeated actions. Agree API changes through a contract with `backend-agent`.

Run targeted checks and add necessary regressions. Run `make check` only when designated the final gate owner.
