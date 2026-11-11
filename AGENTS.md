# Lexicona

Personal EN/RU dictionary and training app for roughly ten users. One process
serves the API and built SPA to phones, tablets, and computers.

## Layout

- `backend/`: FastAPI, SQLAlchemy 2 async, aiosqlite, SQLite WAL, Alembic, uv.
  `src/lexicona/progress.py` defines progress deltas; `normalize.py` compares
  answers. `routers/` contains auth, words, and training; `deps.py` provides
  sessions, CSRF, and database access. `cli.py` offers
  `lexicona-admin create-user | set-password | list-users`; no public signup.
- `frontend/`: React 19, strict TypeScript, Vite, TanStack Query, react-router,
  CSS Modules. Colors use semantic `var(--…)` tokens from `src/theme.css`;
  `src/api.ts` is the sole `fetch` entry point.
- `Dockerfile`, `compose.yaml`, `Caddyfile`: VPS app + Caddy HTTPS delivery;
  Let's Encrypt certificate paths come from `.env`.
- `.local/` is excluded from Git: specification, requirements, mockups, and
  translation-source notes. Check `spec.md` and
  `requirements/approved-training.md` before product features.

## Commands and gate

From `backend/`:

```sh
uv run uvicorn lexicona.main:create_app --factory --reload
uv run alembic upgrade head
uv run alembic revision --autogenerate -m "…"
uv run ruff format . && uv run ruff check . && uv run mypy && uv run pytest
```

From `frontend/`:

```sh
npm run dev
npm run format:check && npm run lint && npm test && npm run build
```

API development uses port 8000; Vite uses 5173 and proxies `/api` to 8000.
`npm run build` includes type checks. Install locked dependencies with
`make install`. The single final gate is `make check`, matching CI in
`.github/workflows/ci.yml`. Codex's `.codex/hooks/format.py` handles
`apply_patch`; Grok's `.grok/hooks/format.py` handles `search_replace` and
`write`. After shell edits run `make fmt`. Hooks require review/trust through
`/hooks`; the gate remains required without them.

## Product invariants

- Word progress is a nonnegative unbounded integer, not CEFR or a probability.
  Reaching 100 does not remove or exclude a word. Deltas in `progress.py` depend
  on difficulty, captured at session start; passive listening only adds progress.
- Only the server judges correctness; it withholds the right answer until
  submission. Repeated/concurrent answers cannot credit one item twice.
  Corrections after the first choice/matching/input error use delta zero with
  no further SRS effect. Cards/cloze cannot start new sessions, but legacy
  snapshots remain supported.
- A normalized headword or translation-set change resets progress and raises
  `content_version`, invalidating old answers. Case, examples, and notes are
  cosmetic. Exclude/restore are reversible and preserve progress and content
  version; separate `training_version` invalidates previous open items even
  after restoration. New sessions select active words only.
- Hints, skips, and TTS failure are neither correct answers nor penalties.
- EN→RU matching groups contain at most eight unambiguous pairs. Correct pairs
  award half the CHOICE reward, rounded down with minimum one; errors use the
  CHOICE penalty. The first attempt determines the effect; group completion
  adds no progress.
- Multiple selected tags combine by OR in dictionary and training.
- Approved scope as of 2026-11-03: resume training, statistics, PWA installation,
  DeepSeek/OpenRouter, and additional local voices. New modes, collections,
  import/export, themes, signup/account deletion, and server backups are deferred.

## Engineering invariants

- Every user-data query filters by `owner_id`; inaccessible objects return 404.
  Each new endpoint needs a second-user isolation test.
- Mutations require `X-CSRF-Token`, checked by `current_auth`; `/api/*` responses
  use `Cache-Control: no-store`. Do not store words/tokens in localStorage.
- Schema changes use Alembic. `tests/test_app.py` checks model/migration parity.
- Business logic, normalization, training, owner isolation, CSRF, and API
  regressions need behavioral tests; total coverage of 100% is not required.
- Store naive UTC via `db.utcnow()` because SQLite discards tzinfo.
- Paid DeepSeek through OpenRouter was approved on 2026-11-03 for language hints
  and examples. Other paid APIs, Redis, Celery, and microservices are outside
  scope. Confirm the execution location before choosing local TTS.

## Git and deployment

Author and committer must be the user from `git config user.name` and `git config user.email`.

### Task-scoped history-rewrite authorization

Global GIT prohibits history rewriting and force-push by default. The user
explicitly requested replacement of this task commit on 2026-11-11:
`b48b76e6ad944856c4e242c106e2cfb47a0d754e`.
This is a task-scoped exception for this repository, preserving independent
later commits and using the verified old remote OID as an explicit lease.
It is not standing permission for later tasks: another rewrite requires an
explicit user request naming that work. The procedure below applies only
within such an authorized scope; a guard accepting its syntax is not approval.

Use `main`, one completed task per commit. Incorporate same-task corrections
into that task's commit only when history rewriting is authorized; preserve
subsequent changes and existing co-authors. For an authorized published rewrite,
use an explicit target branch and `--force-with-lease` with the verified full
previous remote OID. Stop and inspect remote changes if the lease fails.
Only the orchestrator commits, pushes, or changes branches. The repository
starts from its new root commit; do not restore old branches or tags.

Deployment targets a Docker VPS that also runs VPN. Agree on ports 80/443,
subdomain, and DNS before changing the server.

## Ticket workflow

The orchestrator handles one vertical ticket: outcome, acceptance criteria (AC),
file boundaries, dependency order, check owner, and limitations. Shared protocol:
`.codex/TASKS.md`, `.codex/PROJECT.md`, `.codex/TASKS-archive.md`.
Private product requirements remain under `.local/`.

1. Define AC, owners, and checks from the specification. Use `architect` only
   for a concrete architecture, API, or schema risk.
2. Assign only needed `backend-agent`, `frontend-agent`, and `devops-agent`
   roles in dependency order; use `tests-agent` for an uncovered complex
   regression. Delegate with the ticket, AC, file boundaries, and prior report.
3. The designated gate owner, usually the final implementer, runs `make check`
   after code and tests are complete.
4. Independent `code-reviewer` reads the whole diff and checks AC, security, and
   gate evidence; returns `Ship` or `No-Ship` with files and reproduction steps.
5. The orchestrator accepts and archives the ticket, or increments the attempt
   and returns findings to owners before another review.

Use the same gate evidence for the same code. Repeat the gate after relevant
code/test/check-configuration changes or failure; a protocol/status-only edit
does not require a redundant full run. Run mutation experiments only on a
temporary copy outside the working tree. Parallel edits require disjoint files;
do not create agents for every minor edit. If delegation is unavailable or a
role cannot be selected, perform the stages sequentially and identify review
as self-review where applicable.

## Codex integration

Roles are `.codex/agents/*.toml`. `architect`/`code-reviewer` use the latest
available stable Sol family with effort `high`; backend/frontend/devops/tests
use the latest stable Terra family with `high`. Read exact IDs from the role
TOML, including manual delegation; do not copy IDs from old tickets.
`./scripts/codex` / `make codex` refresh supported stable models through the
app-server catalog without changing the main session's chosen model.
`make codex-models` only refreshes config; unavailable catalogs preserve the
current values. Desktop direct launch bypasses the wrapper and existing sessions
do not reload automatically. When the tool does not load a role TOML, explicitly
pass its model, effort, and instructions.

## Grok integration

Grok-specific roles/hooks live under `.grok/`; `.grok/config.toml` loads MCP,
plugins, and permission rules without pinning the session model. Start with
`make grok` or `GROK_AGENT=lexicona-orchestrator grok`. Context7 uses the configured
`https://mcp.context7.com/mcp` endpoint. Use the shared ticket protocol above;
shared protocol documents are not Codex runtime configuration.
Changes to `.codex/` runtime config, `scripts/codex`, and
`scripts/codex_models.py` by Grok require explicit user authorization.

## Repository synchronization

For safe upstream synchronization use [.agents/WORKFLOW.md](.agents/WORKFLOW.md).
Its local Git opt-in records the specifically approved server-sync exception.
