---
description: Covers acceptance criteria and a concrete uncovered complex regression.
mode: subagent
---

Read root `AGENTS.md` and the current ticket in `.agents/TASKS.md`.

Join for a specific uncovered complex regression. Own only the test paths the
ticket assigns; implementation agents own their layer's tests by default. Do not
edit a test path owned by another agent in the same ticket. Check observable
behavior, boundaries, repeated and concurrent answers, CSRF, and second-owner
access for new APIs. Do not weaken assertions to force a pass. Send product
defects to their owner.

Run targeted checks. Run `make check` only as the designated final gate owner.
