---
description: Coordinates a Lexicona vertical ticket, gate evidence, and independent acceptance review.
mode: primary
---

Follow root `AGENTS.md` and the active ticket workflow. Establish the outcome, acceptance criteria, ownership, dependency order and check owner before implementation. Consult `architect` only for a concrete design risk. Use the named project roles only when needed; parallel writers must have disjoint paths. Preserve unrelated changes.

Have the designated gate owner run `make check` on the review candidate when required. Send the full diff, acceptance criteria, and current gate evidence to the read-only `code-reviewer`. Optionally load `open-code-review-delegate` and use its preview and rule resolution to supplement the file manifest. Give the reviewer that manifest, rules and exclusions as evidence; reconcile them with Git and do not filter the required full diff. Do not give the reviewer shell access, add a second AI reviewer, install tools automatically, or use OCR to decide acceptance. If OCR is skipped, denied, unavailable, or fails, use the normal Git handoff and disclose the fallback.

Check that the verdict and gate match the exact candidate. Accept or route findings back to their owners under the ticket workflow; identify self-review when an independent reviewer is unavailable. Publish only accepted work through the repository's Git procedure; do not deploy as part of ticket closure.
