#!/usr/bin/env bash
#
# 100-agent-label-permission-grant.sh
#
# Cross-project issue label mutation for agent principals (e.g. Triage Bot).
#
# Bug: `PATCH /api/issues/:id` with a `labelIds`-only body is authorized via
# the generic `issue:mutate` boundary (services/authorization.js decide()),
# which for an agent actor only allows: self-assigned issues, unassigned
# issues, or an explicit `principalPermissionGrants` row IF the action's
# permissionKey is non-null. But `permissionForAction("issue:mutate")` returns
# null, so grants are never consulted for this action — an agent (e.g. the
# Triage Bot) can NEVER label an issue owned by a different agent, no matter
# what permission it holds. A second, separate ownership re-check right after
# (`issue.assigneeAgentId !== actorAgentId`) denies it again even if the first
# gate were bypassed. Tracked upstream-of-this-repo in Paperclip issues
# QUE-242/QUE-274/QUE-299/QUE-300 — a prior attempt patched this directly in
# the running container via `docker exec` (not build.d/), so it silently
# reverted on the next `--force-recreate`.
#
# Fix (routes/issues.js, assertAgentIssueMutationAllowed): when the PATCH body
# touches only `labelIds` (ignoring the conversational fields already stripped
# elsewhere: comment/reviewRequest/reopen/resume/interrupt/hiddenAt), check a
# NEW, narrowly-scoped permission key `issue:labels:update_any` via the
# existing generic grant path (decideIssueAccess -> decide() -> permissionKey
# is non-null for any action not explicitly special-cased in
# permissionForAction(), so this needs zero changes to authorization.js).
# If granted, bypass both the issue:mutate boundary gate and the ownership
# re-check gate — but ONLY for that labelIds-only request; every other field
# mutation on someone else's issue is denied exactly as before.
#
# Fix (routes/access.js): there is no existing API to grant a
# `principalPermissionGrants` row to an AGENT principal — the only exposed
# route (`PATCH /companies/:companyId/members/:memberId/permissions`) keys off
# `companyMemberships.id`, and agents never get a companyMemberships row.
# Add a sibling board-gated route (same `users:manage_permissions` permission
# check as the members route) that calls the already-existing
# `access.setPrincipalPermission(companyId, "agent", agentId, ...)` service
# function directly. This is the durable, reusable way to grant this (or any
# future) permission key to an agent, instead of touching the database by hand.
#
# Build-time, idempotent, fail-loud.
set -euo pipefail

source "$(dirname "$(readlink -f "$0")")/../lib/common.sh"
PC_LOG_PREFIX="agent-label-grant"
PC_PATCH_LIB="$(dirname "$(readlink -f "$0")")/../lib/patch.js"

BASE="${PAPERCLIP_SERVER_DIST:-$PC_SERVER_DIST_DEFAULT}"
ISSUES_ROUTE="${ISSUES_ROUTE_OVERRIDE:-$BASE/routes/issues.js}"
ACCESS_ROUTE="${ACCESS_ROUTE_OVERRIDE:-$BASE/routes/access.js}"

for f in "$ISSUES_ROUTE" "$ACCESS_ROUTE"; do
  [ -f "$f" ] || pc_die "target not found: $f"
done

ISSUES_ROUTE="$ISSUES_ROUTE" ACCESS_ROUTE="$ACCESS_ROUTE" PC_PATCH_LIB="$PC_PATCH_LIB" node <<'NODE'
const { applyPatch } = require(process.env.PC_PATCH_LIB);
const MARKER = 'PAPERCLIP_ISSUE_LABELS_UPDATE_ANY_PATCH';

applyPatch({
  file: process.env.ISSUES_ROUTE,
  marker: MARKER,
  mode: 'loud',
  prefix: 'agent-label-grant',
  edits: [
    {
      label: 'boundary gate: compute + honour the labelIds-only grant',
      anchor:
`        const boundaryDecision = await decideIssueAccess(req, issue, "issue:mutate");
        if (!boundaryDecision.allowed) {
            res.status(403).json({ error: "Issue is outside this actor's authorization boundary" });
            return false;
        }`,
      replacement:
`        const pcLabelOnlyBodyKeys = req.body && typeof req.body === "object"
            ? Object.keys(req.body).filter((k) => !["comment", "reviewRequest", "reopen", "resume", "interrupt", "hiddenAt"].includes(k))
            : [];
        const pcIsLabelOnlyMutation = pcLabelOnlyBodyKeys.length === 1 && pcLabelOnlyBodyKeys[0] === "labelIds";
        const pcIsLabelOnlyGrantedMutation = pcIsLabelOnlyMutation &&
            (await decideIssueAccess(req, issue, "issue:labels:update_any")).allowed; /* ${MARKER} */
        const boundaryDecision = await decideIssueAccess(req, issue, "issue:mutate");
        if (!boundaryDecision.allowed && !pcIsLabelOnlyGrantedMutation) {
            res.status(403).json({ error: "Issue is outside this actor's authorization boundary" });
            return false;
        }`,
    },
    {
      label: 'ownership re-check: bypass for a granted labelIds-only mutation',
      anchor:
`        if (issue.assigneeAgentId !== actorAgentId) {
            if (await hasActiveCheckoutManagementOverride(actorAgentId, issue.companyId, issue.assigneeAgentId)) {
                return true;
            }`,
      replacement:
`        if (issue.assigneeAgentId !== actorAgentId) {
            if (pcIsLabelOnlyGrantedMutation) {
                return true;
            }
            if (await hasActiveCheckoutManagementOverride(actorAgentId, issue.companyId, issue.assigneeAgentId)) {
                return true;
            }`,
    },
  ],
});

applyPatch({
  file: process.env.ACCESS_ROUTE,
  marker: MARKER,
  mode: 'loud',
  prefix: 'agent-label-grant',
  edits: [
    {
      label: 'new route: grant/revoke a permission key on an agent principal',
      anchor:
`        res.json(member);
    });
    router.post("/admin/users/:userId/promote-instance-admin", async (req, res) => {`,
      replacement:
`        res.json(member);
    });
    // ${MARKER}: durable way to grant a principalPermissionGrants row to an
    // AGENT principal — agents never get a companyMemberships row, so the
    // sibling /members/:memberId/permissions route above can't target them.
    // Same board gate (users:manage_permissions) as that route.
    router.patch("/companies/:companyId/agents/:agentId/permissions", async (req, res) => {
        const companyId = req.params.companyId;
        const agentId = req.params.agentId;
        await assertCompanyPermission(req, companyId, "users:manage_permissions");
        const { permissionKey, enabled, scope } = req.body ?? {};
        if (typeof permissionKey !== "string" || !permissionKey.trim()) {
            res.status(400).json({ error: "permissionKey is required" });
            return;
        }
        await access.setPrincipalPermission(companyId, "agent", agentId, permissionKey, enabled !== false, req.actor.userId ?? null, scope ?? null);
        const grants = await access.listPrincipalGrants(companyId, "agent", agentId);
        await logActivity(db, {
            companyId,
            actorType: "user",
            actorId: req.actor.userId ?? "board",
            action: "agent_principal.permissions_updated",
            entityType: "agent",
            entityId: agentId,
            details: { permissionKey, enabled: enabled !== false },
        });
        res.json({ agentId, grants });
    });
    router.post("/admin/users/:userId/promote-instance-admin", async (req, res) => {`,
    },
  ],
});
NODE
