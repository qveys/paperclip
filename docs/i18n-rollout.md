# i18n rollout — granular split of #1

## Why this exists

PR [#1](https://github.com/qveys/paperclip/pull/1) (`feat(i18n): add Weblate-backed UI localization with debug tooling`) introduced the i18n stack in a single 27,301 / -3,310 LOC change across 215 files. GitHub Copilot refused review (>20k LOC limit), and the change was hard for humans to digest as one unit.

This document tracks the **granular replacement**: ~33 focused PRs, each doing one thing, in stacked branches. Repository issues/discussions/wiki are disabled on this fork, so this file is the canonical tracking surface — keep it updated as PRs land.

## Goals

- Each PR is **realistic for human review** (≤500 LOC of real code; locale JSONs are excluded from that quota since they get reviewed by translators, not engineers).
- Each PR has a **clear story** (e.g., "install deps", "bundle EN locale", "migrate `Auth` pages to `useT`").
- After every PR merges, the app **still works** (EN-only fallback if non-EN locales not yet bundled).
- Every PR is **under Copilot's 20k LOC review limit**.

## Source branch

The original 27k LOC change lives on `feat/i18n-fr-via-weblate` (kept on `origin` until rollout completes). Files for each PR are extracted from there with `git checkout origin/feat/i18n-fr-via-weblate -- <paths>`.

## PR roadmap

### Tronc commun — runtime (sequential, stacked)

Each PR's `base` is the previous branch in the stack. GitHub auto-retargets to `master` on merge.

- [ ] **PR 1** — `i18n/01-deps` — add `i18next`, `react-i18next`, `i18next-chained-backend`, `i18next-cli` deps + lockfile regen
- [ ] **PR 2** — `i18n/02-extractor-config` — `ui/i18next.config.ts`
- [ ] **PR 3** — `i18n/03-locale-en-bundled` — EN locale catalog (13 namespaces) + `ui/src/i18n/resources.ts` registry
- [ ] **PR 4** — `i18n/04-runtime-init` — `ui/src/i18n/index.ts` chained backend (Weblate → bundle) + `main.tsx` bootstrap
- [ ] **PR 5** — `i18n/05-useT-hook` — `useT` hook with `translated`/`fallback-en`/`missing` metadata + tests
- [ ] **PR 6** — `i18n/06-debug-overlay` — `useI18nDebug` (Ctrl/Cmd+Shift+L) + `I18nDebugStyles` + CSS + tests
- [ ] **PR 7** — `i18n/07-language-switcher` — `LanguageSwitcher` component + `localStorage` persistence + tests
- [ ] **PR 8** — `i18n/08-language-switcher-wiring` — wire into `ProfileSettings` + `SidebarAccountMenu`

> After PR 8: i18n fully operational in EN. App identical to today; non-EN locales fall back to EN.

### CI / docs (sequential, after PR 8)

- [ ] **PR 9** — `i18n/09-ci-extract` — `.github/workflows/i18n-extract.yml` (PR check, fail on EN drift)
- [ ] **PR 10** — `i18n/10-ci-weblate-push` — `.github/workflows/i18n-push-source.yml` (master → Weblate upload)
- [ ] **PR 11** — `i18n/11-readme-weblate` — README badges + Weblate contributor section

### String migrations — pages (parallel, after PR 8, one per domain)

- [ ] **PR 12** — `i18n/12-strings-auth` — `Auth`, `CliAuth`, `InviteLanding`, `BoardClaim`, `JoinRequestQueue`
- [ ] **PR 13** — `i18n/13-strings-dashboard` — `Dashboard`, `DashboardLive`, `Activity`, `Inbox`, `MyIssues`
- [ ] **PR 14** — `i18n/14-strings-agents` — `Agents`, `AgentDetail`, `NewAgent`, `Approvals`, `ApprovalDetail`
- [ ] **PR 15** — `i18n/15-strings-issues` — `Issues`, `IssueDetail`
- [ ] **PR 16** — `i18n/16-strings-routines` — `Routines`, `RoutineDetail`, `RunTranscriptUxLab`
- [ ] **PR 17** — `i18n/17-strings-projects` — `Projects`, `ProjectDetail`, `ProjectWorkspaceDetail`, `Workspaces`, `ExecutionWorkspaceDetail`
- [ ] **PR 18** — `i18n/18-strings-goals` — `Goals`, `GoalDetail`
- [ ] **PR 19** — `i18n/19-strings-org` — `Org`, `OrgChart`, `Companies`, `Company*`, `UserProfile`
- [ ] **PR 20** — `i18n/20-strings-instance` — `Instance*`, `Costs`
- [ ] **PR 21** — `i18n/21-strings-plugins` — `PluginManager`, `PluginPage`, `PluginSettings`, `AdapterManager`, `NotFound`

### String migrations — components (parallel, after PR 8, one per subfolder)

- [ ] **PR 22** — `i18n/22-components-sidebar` — `ui/src/components/sidebar/*`
- [ ] **PR 23** — `i18n/23-components-agents` — `ui/src/components/agents/*`
- [ ] **PR 24** — `i18n/24-components-issues` — `ui/src/components/issues/*`
- [ ] **PR 25** — `i18n/25-components-routines` — `ui/src/components/routines/*`
- [ ] **PR 26** — `i18n/26-components-projects` — `ui/src/components/projects/*`
- [ ] **PR 27** — `i18n/27-components-plugins` — `ui/src/components/plugins/*`
- [ ] **PR 28** — `i18n/28-components-shared` — remaining cross-cutting components

### Locale catalogs (parallel, after PR 3, one per language)

- [ ] **PR 29** — `i18n/29-locale-fr` — `ui/src/i18n/locales/fr-FR/*.json` (12 namespaces)
- [ ] **PR 30** — `i18n/30-locale-de` — `ui/src/i18n/locales/de-DE/*.json`
- [ ] **PR 31** — `i18n/31-locale-es` — `ui/src/i18n/locales/es-ES/*.json`
- [ ] **PR 32** — `i18n/32-locale-ja` — `ui/src/i18n/locales/ja-JP/*.json`
- [ ] **PR 33** — `i18n/33-locale-zh` — `ui/src/i18n/locales/zh-CN/*.json`

> Note: EN has 13 namespaces; non-EN locales have 12 (no `projects.json`). Mirrors what's currently in `feat/i18n-fr-via-weblate`.

## Dependency graph

```
master → 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8
                              │       ├→ 9 → 10 → 11    (CI/docs, sequential)
                              │       ├→ 12, 13, ..., 21  (page strings, parallel)
                              │       └→ 22, 23, ..., 28  (component strings, parallel)
                              └─────→ 29, 30, 31, 32, 33  (locales, parallel)
```

## Conventions for each PR

- **Title**: conventional commits with `feat(i18n)`, `chore(i18n)`, or `docs(i18n)` scope.
- **Body**: includes a "Part of i18n rollout" section linking back to this doc.
- **Base**: previous branch in the stack (GitHub auto-retargets on merge).
- **Verification**:
  - PRs 1-8 (real code): `pnpm typecheck` + targeted vitest run.
  - PRs 9-33 (mechanical / locale data): typecheck only; reviewers eyeball the pattern.

## Lockfile

PR 1 regenerates `pnpm-lock.yaml` via `pnpm install`. The original `feat/i18n-fr-via-weblate` skipped this and relied on CI's `--no-frozen-lockfile` workaround; the split takes the cleaner path.

## Status legend

- [ ] open / not yet created
- [x] merged
- 🚧 = open & under review
- ❌ = closed without merge

Update this file in each PR when state changes.
