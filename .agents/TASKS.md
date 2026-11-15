# Active tasks

Audit run 2026-11-15. Source: full read-only review of commit 24b0428.
All tickets below are closed by commits 5faf773..2862b6e; this record is removed
in the next commit and remains only in Git history.

- T-01 [high] Deploy: missing `backend/data` bind-mount is created root-owned and the app cannot write. AC: README/compose flow creates and owns the directory before `up`; `.env.example` explains ownership. Files: README.md, .env.example. Owner: devops.
- T-02 [high] Login throttle keyed by casefold but lookup is case-sensitive; case variants lock any account. AC: throttle key matches the lookup rule; keys are bounded (eviction). Files: security.py, routers/auth.py, tests. Owner: backend.
- T-03 [high] Anonymous login can allocate 40×64 MiB Argon2. AC: password verify/hash concurrency is bounded; peak memory documented. Files: security.py, routers/auth.py, tests. Owner: backend.
- T-04 [high] Fully hinted answer earns half instead of zero for phrases/apostrophes/hyphens, and advances SRS. AC: zero delta when every step was hinted; no SRS advance for a fully hinted answer; tests for phrase/apostrophe/hyphen. Files: normalize.py, progress.py, routers/training.py, tests. Owner: backend.
- T-05 [high] Auto-check resubmits after network/hint failure, fires while the word editor is open, during IME composition, and accepts `.`. AC: only a new user edit arms it; editor/composition/manual-validity rules respected; regression tests. Files: TrainingPage.tsx, tests. Owner: frontend.
- T-06 [medium] Corrupt dictionary index silently falls back to paid providers with 200; lookup blocks the event loop. AC: corrupt index → 503; missing index keeps fallback; lookup/notices run in a thread. Files: routers/dictionary.py, tests. Owner: backend.
- T-07 [medium] Requests have no timeout; a hung answer disables the whole training screen. AC: bounded client timeout with a friendly message; long AI calls keep their own budget. Files: api.ts, api.test.ts. Owner: frontend.
- T-08 [medium] AI example overwrites edits typed while the request is in flight. AC: concurrent edits are never overwritten; append preserves them; regression test. Files: WordForm.tsx, tests. Owner: frontend.
- T-09 [medium] A late save response closes a newly opened editor/draft. AC: onSuccess closes only the editor it saved. Files: WordsPage.tsx, tests. Owner: frontend.
- T-10 [medium] CLI creates accounts that cannot log in and accepts 8-char passwords. AC: login 1..64, password 12..128, clear missing-migration message. Files: cli.py, tests. Owner: backend.
- T-11 [medium] Passwords echo in 422 validation bodies. AC: validation errors omit input/ctx. Files: main.py, tests. Owner: backend.
- T-12 [medium] TTS cache bounded by clip count only (~200 MB). AC: total byte budget with eviction. Files: kokoro.py, tests. Owner: backend.
- T-13 [medium] `BEGIN IMMEDIATE` timeout returns 500. AC: 503 with retryable detail. Files: words.py, tests. Owner: backend.
- T-14 [medium] Spec: no unsaved-changes warning and no progress-reset warning in the word editor. AC: both warnings implemented and tested. Files: WordsPage.tsx, WordForm.tsx, Layout.tsx, words.ts, tests. Owner: frontend.
- T-15 [medium] Hint endpoint is a free oracle: wrong guesses never become a first attempt/SRS error. AC: documented decision; SRS does not advance on fully hinted answers (T-04); no hidden scoring change. Files: PROJECT.md. Owner: orchestrator.
- T-16 [low] Statistics: accuracy 0 vs null, totals disappear on period switch, table lacks caption/scope. AC: null when empty, previous data kept, accessible table. Files: statistics.py, StatisticsPage.tsx, pages.module.css, tests. Owner: backend+frontend.
- T-17 [low] Completion screen lost its heading. AC: visually hidden h1. Files: TrainingSummary.tsx, pages.module.css. Owner: frontend.
- T-18 [low] Focus falls to body after delete and after Next. AC: focus moves to the next meaningful target. Files: WordsPage.tsx, TrainingPage.tsx, MatchingRun.tsx. Owner: frontend.
- T-19 [low] Auto-advance can wait for speech forever while Next is hidden. AC: bounded wait, manual continuation possible. Files: useAutoAdvance.ts, tests. Owner: frontend.
- T-20 [low] A session created before a tab hide is silently dropped. AC: only unmount cancels start. Files: TrainingPage.tsx, tests. Owner: frontend.
- T-21 [low] Expired auth sessions are never deleted. AC: cleanup at login. Files: routers/auth.py, tests. Owner: backend.
- T-22 [low] `index.html` has no Cache-Control. AC: shell revalidates, hashed assets immutable. Files: main.py, tests. Owner: backend.
- T-23 [low] No HSTS, no proxy access log. AC: HSTS and Caddy log enabled. Files: Caddyfile. Owner: devops.
- T-24 [low] CI never builds the image or validates compose. AC: docker build + compose config job. Files: .github/workflows/ci.yml. Owner: devops.
- T-25 [low] Provider chunked-response HTTPException → 500. AC: mapped to 503. Files: translation.py, tests. Owner: backend.
- T-26 [low] Local tag id regex allows 64 chars, server 32. AC: both 32. Files: wordFilters.ts, tests. Owner: frontend.
- T-27 [low] Resume shows `open` after exclude→restore although answers are unavailable. AC: snapshot marks training_version drift unavailable. Files: training.py, tests. Owner: backend.
- T-28 [low] Corrupt matching snapshot makes summary 409 forever. AC: summary tolerates it. Files: training.py, tests. Owner: backend.
- T-29 [low] Legacy answered row with NULL delta → 500. AC: graceful delta 0. Files: training.py, tests. Owner: backend.
- T-30 [low] Invalid stored preference sections are preserved and rewritten silently. AC: invalid sections are dropped on write. Files: routers/auth.py, tests. Owner: backend.
- T-31 [low] Distractors contract drift (builtin list vs dictionary pool). AC: PROJECT.md matches code. Files: PROJECT.md. Owner: orchestrator.
- T-32 [low] Accepted risks: public OpenAPI, search query in access logs, alembic parity gaps. AC: documented in PROJECT.md. Files: PROJECT.md. Owner: orchestrator.
- T-33 [low] Install section absent on iOS/Firefox. AC: manual iOS hint shown when no prompt. Files: InstallSettings.tsx, install.ts, tests. Owner: frontend.
- T-34 [low] Session load error leaves a dead screen. AC: retry control. Files: App.tsx, tests. Owner: frontend.
- T-35 [low] Hint/answer race uses stale letter_hints. AC: documented residual risk with rationale. Files: PROJECT.md. Owner: orchestrator.

## Ticket template

- ID / outcome / status / attempt
- Acceptance criteria / scope exclusions
- File boundaries / owners / dependency order
- Contracts / check owner
- Verification evidence / independent review
- Acceptance / limitations
