# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Start here

**`AGENTS.md` at the repo root is the primary contributor guide and applies in full here** — repo map, dev setup, core engineering rules (company-scoping, contract sync, control-plane invariants), the DB change workflow, verification commands, API/auth expectations, UI expectations, PR template requirements, and the design-system token rule. Read it before making changes; this file only adds context that AGENTS.md doesn't cover.

Before non-trivial changes, also read in order: `doc/GOAL.md`, `doc/PRODUCT.md`, `doc/SPEC-implementation.md`, `doc/DEVELOPING.md`, `doc/DATABASE.md`.

## What this project is

Paperclip is a control plane for AI-agent companies: a Node.js/Express API + React/Vite UI that orchestrates teams of AI agents (Claude Code, Codex, Cursor, OpenClaw, bash/HTTP bots, etc.) with org charts, task/issue tracking, budgets, governance/approvals, and scheduled "heartbeat" execution.

## Common commands

```sh
pnpm install
pnpm dev                 # start API+UI on http://localhost:3100 (embedded PGlite/Postgres if DATABASE_URL unset)
pnpm dev:once             # same, without file watching; auto-applies pending migrations
pnpm dev:list / dev:stop  # inspect/stop the managed dev runner

pnpm test                 # Vitest suite — default cheap check, run this for most changes
pnpm test:watch
pnpm test:e2e             # Playwright, opt-in — only when touching browser flows
pnpm test:release-smoke   # opt-in — CI/release verification

pnpm -r typecheck         # repo-wide typecheck
pnpm build                # repo-wide build
pnpm db:generate          # generate a Drizzle migration after editing packages/db/src/schema/*.ts
pnpm db:migrate           # apply migrations
pnpm check:token-gates    # required before committing ui/ changes — enforces the DESIGN.md token rule
```

Run the smallest relevant check for the change at hand; reserve `pnpm -r typecheck && pnpm test:run && pnpm build` for PR-ready hand-off (see AGENTS.md §7).

Run a single Vitest test file directly (bypasses the stable-runner wrapper) with `pnpm exec vitest run <path>` from the relevant package, or `pnpm --filter <package> exec vitest run <path>` from the root.

## Architecture

**Workspace layout** (pnpm workspace, packages listed in `pnpm-workspace.yaml`):
- `server/` — Express API and orchestration services (identity/access, work & tasks, heartbeat execution, governance/approvals, org chart, workspaces/runtime, plugins, budget/cost, routines/schedules, secrets/storage, activity/events, company import/export). Routes live under `server/src/routes`, longer-running logic under `server/src/services`.
- `ui/` — React 19 + Vite board UI, served by the API server in dev middleware mode (same origin as the API). Storybook lives under `ui/storybook/` (not app routes).
- `packages/db/` — Drizzle ORM schema (`src/schema/`), migrations, and DB clients. Migrations are generated from *compiled* schema (`dist/schema/*.js`), so `pnpm db:generate` builds the package first.
- `packages/shared/` — types, constants, validators, and API path constants shared between `server` and `ui`. This is the contract layer both sides import from.
- `packages/adapters/*` — one package per agent runtime integration (`claude-local`, `codex-local`, `cursor-local`, `cursor-cloud`, `gemini-local`, `grok-local`, `hermes`, `hermes-gateway`, `openclaw-gateway`, `opencode-local`, `pi-local`). See `packages/adapters/AUTHORING.md` for the adapter contract.
- `packages/adapter-utils/` — shared helpers for adapter packages.
- `packages/plugins/*` — the instance-wide plugin system (out-of-process workers, capability-gated host services, job scheduling, tool exposure, UI contributions).
- `packages/skills-catalog/`, `packages/teams-catalog/` — app-shipped catalogs of skills/teams surfaced in the product UI (distinct from `skills/`, which are Paperclip's own operational skills for working *in* this repo).
- `cli/` — the published `paperclipai` CLI (bin), used for onboarding, doctor/repair, auth bootstrap, and running the server.
- `doc/` — operational and product docs; `doc/plans/` for dated repo planning docs (`YYYY-MM-DD-slug.md`).

**Cross-cutting invariant**: everything in the domain model is company-scoped, and a schema/behavior change typically touches four layers together — `packages/db` schema → `packages/shared` types/constants/validators → `server` routes/services → `ui` API clients/pages. AGENTS.md §5 calls this out explicitly as "keep contracts synchronized"; when planning a change, expect to touch all four.

**Heartbeat execution** is the core runtime loop: a DB-backed wakeup queue (with coalescing) drives budget checks, workspace resolution, secret injection, skill loading, and adapter invocation for each agent run; runs produce structured logs, cost events, session state, and audit trails, with orphaned-run recovery on restart. Most "agent does work" features touch this path (`server/src/services`, the relevant `packages/adapters/*` package, and `packages/db` heartbeat/run tables).

**Auth**: two deployment modes, `local_trusted` and `authenticated` (with private/public exposure) — see `doc/DEPLOYMENT-MODES.md`. Board (human) access is full-control operator context; agent access uses hashed bearer API keys (`agent_api_keys`) that must not cross company boundaries.

## Design system

`DESIGN.md` at the repo root is the source of truth for UI design decisions, and `ui/` changes must follow it — see AGENTS.md's "Design system" section for the token-only rule and the required `pnpm check:token-gates` check.
