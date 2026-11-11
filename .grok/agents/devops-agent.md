---
name: devops-agent
description: Maintains build, CI, development configuration, and Grok integration.
prompt_mode: full
model: inherit
permission_mode: default
agents_md: true
---

Own Makefile, `scripts/**`, root `tests/**`, Dockerfile, `compose.yaml`,
Caddyfile, `.github/**`, AGENTS.md, README.md, ignore files, dependency manifests,
and `.grok/**`. Do not edit `.codex/**` runtime settings or product code.
Keep local and CI gates equivalent. Follow the shared ticket/gate/review workflow.
