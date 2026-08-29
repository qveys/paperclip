#!/usr/bin/env bash
#
# 10-telegram-worker-patches.sh
#
# Patches paperclip-plugin-telegram/dist/worker.js at every container boot, in
# two independently marker-gated passes (same file, same pattern as
# 37-company-wizard-secret-resolve.sh):
#
#   Section A — PAPERCLIP_AGENT_TOPICS_V3 : per-agent Telegram topic routing
#     (auto-create + persist a forum topic per agent, route all notifs for
#     that agent via its message_thread_id). Runs FIRST.
#   Section C — PAPERCLIP_TELEGRAM_V4 : agent-name enrichment, issue+duration
#     enrichment, rich Agent/Statut/Durée card, and same-run edit-in-place
#     (started+finished collapse into one Telegram message). Runs SECOND.
#
# Ordering is deliberate and load-bearing: Section C's notify-signature edit
# adds an optional 5th "runTrackingKey" param to notify(). Section A's
# fresh-install anchor for notify()'s declaration line therefore resolves
# dynamically to whichever arity is ACTUALLY on disk at patch time (4-arg on
# a pristine plugin, 5-arg if Section C already ran on some other volume
# state) instead of a hardcoded literal.
#
# This fixes a real bug found while consolidating these scripts: with the
# previous 3-file layout (10-telegram-agentname.sh, 20-telegram-richnotif.sh,
# 25-telegram-agent-topics.sh), the agentname patch ran before the
# agent-topics patch and bumped the notify signature first — agent-topics'
# hardcoded 4-arg anchor then never matched, so per-agent topic routing
# silently failed to apply on any fresh install or plugin reinstall (soft-fail
# warning only, easy to miss in boot logs). Verified against a pristine
# paperclip-plugin-telegram@0.6.1 package (npm pack) and against the current
# production worker.js (already patched historically, must stay a no-op).
#
# Historical note: a third pass, PAPERCLIP_RICHNOTIF_PATCH (formerly
# entrypoint.d/20-telegram-richnotif.sh), is intentionally NOT ported here —
# see the comment before Section C below for why it's dead code today.
#
# Both sections keep their own legacy migration paths (V1/V2 -> V3 for
# agent-topics; upgrade-from-earlier-iteration anchors for V4) so a volume
# stuck on an older marker state still gets patched forward correctly.
#
# Idempotent (marker per section) + fail-SOFT: must NEVER abort container
# startup. Each section's node step falls through (pc_warn, no exit) on
# failure so trouble in one section doesn't skip the other.
set -uo pipefail

source "$(dirname "$(readlink -f "$0")")/../lib/common.sh"
PC_LOG_PREFIX="telegram-worker-patches"
PC_PATCH_LIB="$(dirname "$(readlink -f "$0")")/../lib/patch.js"

PLUGIN_DIR="${TELEGRAM_PLUGIN_DIR:-$PC_TELEGRAM_PLUGIN_DIR_DEFAULT}"
WORKER="$PLUGIN_DIR/worker.js"

if [ ! -f "$WORKER" ]; then
  pc_warn "plugin worker absent ($WORKER) — skipping (plugin not installed?)."
  exit 0
fi

# ═════════════════════════════════════════════════════════════════════════
# Section A — PAPERCLIP_AGENT_TOPICS_V3 (per-agent topic routing). Runs FIRST.
# ═════════════════════════════════════════════════════════════════════════
#
# State key per agent+chat: agent_topic_{chatId}_{agentId}
#   -> { topicId: <message_thread_id>, agentName: "..." }
WORKER_FILE="$WORKER" PC_PATCH_LIB="$PC_PATCH_LIB" node <<'NODE' || pc_warn "Section A (agent-topics) node patch step failed — continuing."
const fs = require("fs");
const { applyPatch } = require(process.env.PC_PATCH_LIB);
const file = process.env.WORKER_FILE;
const MARKER_V3 = "PAPERCLIP_AGENT_TOPICS_V3";

const helperV3 = [
  "        // PAPERCLIP_AGENT_TOPICS_V3: resolve or auto-create a per-agent Telegram topic.",
  "        // Persists message_thread_id per agent+chat in instance state (Hermes dm_topics model).",
  "        async function __resolveAgentThreadId(chatId, agentId, companyId) {",
  "            const stateKey = `agent_topic_${chatId}_${agentId}`;",
  "            const cached = await ctx.state.get({ scopeKind: \"instance\", stateKey });",
  "            if (cached && cached.topicId) return cached.topicId;",
  "            let agentName = String(agentId);",
  "            try {",
  "                const agent = await ctx.agents.get(String(agentId), companyId);",
  "                if (agent && agent.name) agentName = agent.name;",
  "            } catch { /* best effort */ }",
  "            try {",
  "                const r = await ctx.http.fetch(`${TELEGRAM_API}/bot${token}/createForumTopic`, {",
  "                    method: \"POST\",",
  "                    headers: { \"Content-Type\": \"application/json\" },",
  "                    body: JSON.stringify({ chat_id: chatId, name: agentName.slice(0, 128) }),",
  "                });",
  "                const d = await r.json();",
  "                if (d.ok && d.result && d.result.message_thread_id) {",
  "                    const topicId = d.result.message_thread_id;",
  "                    await ctx.state.set({ scopeKind: \"instance\", stateKey }, { topicId, agentName });",
  "                    ctx.logger.info(\"Created Telegram topic for agent\", { agentId, agentName, topicId });",
  "                    await sendMessage(ctx, token, chatId, escapeMarkdownV2(\"📌 \" + agentName), {",
  "                        parseMode: \"MarkdownV2\",",
  "                        messageThreadId: topicId,",
  "                    });",
  "                    return topicId;",
  "                }",
  "                ctx.logger.warn(\"createForumTopic API error\", { body: JSON.stringify(d).slice(0, 300) });",
  "            } catch (err) {",
  "                ctx.logger.warn(\"createForumTopic failed\", { error: String(err) });",
  "            }",
  "            return undefined;",
  "        }",
].join("\n");

const routingV3 = [
  "            if (!messageThreadId) {",
  "                messageThreadId = await resolveNotificationThreadId(ctx, chatId, event, config.topicRouting);",
  "            }",
  "            // PAPERCLIP_AGENT_TOPICS_V3: per-agent topic routing via persisted message_thread_id",
  "            if (!messageThreadId && (config.perAgentTopics ?? true)) {",
  "                const __atAgentId = event.payload",
  "                    ? (event.payload.agentId || event.payload.assigneeAgentId || null)",
  "                    : null;",
  "                if (__atAgentId) {",
  "                    try {",
  "                        messageThreadId = await __resolveAgentThreadId(chatId, String(__atAgentId), event.companyId);",
  "                    } catch (__atErr) {",
  "                        ctx.logger.warn(\"per-agent topic routing failed\", { error: String(__atErr) });",
  "                    }",
  "                }",
  "            }",
  "            if (messageThreadId) {",
  "                msg.options.messageThreadId = messageThreadId;",
  "            }",
].join("\n");

const routingClean = [
  "            if (!messageThreadId) {",
  "                messageThreadId = await resolveNotificationThreadId(ctx, chatId, event, config.topicRouting);",
  "            }",
  "            if (messageThreadId) {",
  "                msg.options.messageThreadId = messageThreadId;",
  "            }",
].join("\n");

const v2HelperStart = "        // PAPERCLIP_AGENT_TOPICS_V2:";
const v2SendInjectStart = "            // PAPERCLIP_AGENT_TOPICS_V2: per-agent thread routing.";

let src = fs.readFileSync(file, "utf8");

if (src.includes(MARKER_V3)) {
  console.log("[telegram-worker-patches] Section A: already patched (" + MARKER_V3 + "), skipping: " + file);
} else if (src.includes("PAPERCLIP_AGENT_TOPICS_V2")) {
  const i0 = src.indexOf(v2HelperStart);
  const i1 = src.indexOf("        const notify = async (event, formatter, overrideChatId, overrideTopicId) => {", i0);
  if (i0 < 0 || i1 < 0) {
    console.error("[telegram-worker-patches] Section A WARN: V2 migration anchors missing — leaving file untouched.");
  } else {
    src = src.slice(0, i0) + helperV3 + "\n" + src.slice(i1);
    const inj0 = src.indexOf(v2SendInjectStart);
    if (inj0 >= 0) {
      const inj1 = src.indexOf("            const messageId = await sendMessage(ctx, token, chatId, msg.text, msg.options);", inj0);
      if (inj1 > inj0) src = src.slice(0, inj0) + src.slice(inj1);
    }
    src = src.replace(routingClean, routingV3);
    fs.writeFileSync(file, src);
    console.log("[telegram-worker-patches] Section A: migrated V2 -> V3 (message_thread_id persisted per agent)");
  }
} else if (src.includes("PAPERCLIP_AGENT_TOPICS_PATCH")) {
  const i0 = src.indexOf("        // PAPERCLIP_AGENT_TOPICS_PATCH:");
  const i1 = src.indexOf("        const notify = async (event, formatter, overrideChatId, overrideTopicId) => {", i0);
  if (i0 >= 0 && i1 > i0) {
    src = src.slice(0, i0) + helperV3 + "\n" + src.slice(i1);
    src = src.replace(routingClean, routingV3);
    fs.writeFileSync(file, src);
    console.log("[telegram-worker-patches] Section A: migrated V1 -> V3");
  }
} else {
  // Fresh install: resolve the notify() declaration anchor dynamically —
  // it may already be the V4 5-arg signature if Section C below has run on
  // this file before (or, on some other volume, ran first historically).
  // This is the fix for the ordering bug described in the file header.
  const notifyAnchor4 = "        const notify = async (event, formatter, overrideChatId, overrideTopicId) => {";
  const notifyAnchor5 = "        const notify = async (event, formatter, overrideChatId, overrideTopicId, runTrackingKey) => {";
  const notifySigAnchor = src.includes(notifyAnchor5) ? notifyAnchor5 : notifyAnchor4;
  const helperV3WithNotify = helperV3 + "\n" + notifySigAnchor;
  applyPatch({
    file,
    marker: MARKER_V3,
    mode: "soft",
    prefix: "telegram-worker-patches",
    edits: [
      {
        label: "helper-fn",
        anchor: notifySigAnchor,
        replacement: helperV3WithNotify,
      },
      {
        label: "routing-block",
        anchor: routingClean,
        replacement: routingV3,
      },
    ],
  });
}
NODE

# Fix duplicate notify declaration from an earlier V2->V3 migration (bash
# self-heal specific to that migration path — unrelated to Section D below).
if grep -q 'const notify = async.*const notify = async' "$WORKER"; then
  sed -i 's/const notify = async (event, formatter, overrideChatId, overrideTopicId) => {[[:space:]]*const notify = async (event, formatter, overrideChatId, overrideTopicId) => {/const notify = async (event, formatter, overrideChatId, overrideTopicId) => {/' "$WORKER"
  pc_log "worker.js: duplicate notify corrigé (migration V2->V3)"
fi

if grep -q "config.perAgentTopics)" "$WORKER" && ! grep -q "config.perAgentTopics ?? true" "$WORKER"; then
  sed -i 's/config\.perAgentTopics/(config.perAgentTopics ?? true)/g' "$WORKER"
  pc_log "worker.js: perAgentTopics actif par defaut"
fi

CONSTANTS_FILE="$PLUGIN_DIR/constants.js"
if [ -f "$CONSTANTS_FILE" ] && ! grep -q "perAgentTopics:" "$CONSTANTS_FILE"; then
  sed -i 's/topicRouting: false,/topicRouting: false,\n    perAgentTopics: true,/' "$CONSTANTS_FILE"
  pc_log "constants.js: perAgentTopics=true"
fi

# ═════════════════════════════════════════════════════════════════════════
# Historical note: PAPERCLIP_RICHNOTIF_PATCH (formerly entrypoint.d/20-
# telegram-richnotif.sh) is intentionally NOT ported here. Its anchor
# required __enrichAgentName to already exist in the OLD (pre-V4) shape — a
# shape that never occurs on any current path: a pristine plugin doesn't have
# that helper yet, and Section C below installs a richer superset (card
# layout + edit-in-place) under a different shape. It already self-disabled
# (process.exit(0)) once PAPERCLIP_TELEGRAM_V3 was present, and was
# empirically confirmed dead on every fresh-install path once Section C runs.
# Any worker.js still carrying the historical "PAPERCLIP_RICHNOTIF_PATCH"
# comment string from a past boot is unaffected — it's inert, nothing reads it.
# ═════════════════════════════════════════════════════════════════════════

# ═════════════════════════════════════════════════════════════════════════
# Section C — PAPERCLIP_TELEGRAM_V4 (agent-name enrichment, rich cards,
# same-run edit-in-place). Runs SECOND — no dependency on Section A.
# ═════════════════════════════════════════════════════════════════════════
#
#   1. notify-edit    — teaches the shared notify() dispatcher an optional 5th
#      "runTrackingKey" param: when given, it edits the previously-sent message
#      for that key (Telegram editMessageText) instead of posting a new one.
#      Falls back to a normal send if there's nothing to edit yet, the edit
#      target is gone, or it lives in a different chat.
#   2. run-handlers   — adds __enrichAgentName (agent name + issue title/id +
#      duration), __richRun card formatter (ticket+title headline, then a
#      monospace card with Agent/Statut/Durée/Erreur rows), and registers the
#      run events with the rich formatters. started/finished/failed for the
#      SAME run collapse into one Telegram message (edited in place) via
#      runTrackingKey = "run_msg_<runId>".
#   3. resolve-opts   — makes resolveIssueLinksOpts fall back to the
#      PAPERCLIP_APP_URL env var so issue links are HTTPS even when the plugin
#      config does not set paperclipPublicUrl.
#   4. run-failed     — wires __enrichAgentName + the rich failed formatter +
#      runTrackingKey into the error handler (optional), so a failed run edits
#      the same message too (when errors go to the same chat as the default).
#
# The run-handlers anchor for an already-patched worker.js (v3 or earlier v4
# dev iterations) is captured dynamically via regex instead of hand-
# transcribed, since its exact text has drifted across past patch iterations.
WORKER_FILE="$WORKER" PC_PATCH_LIB="$PC_PATCH_LIB" node <<'NODE' || pc_warn "Section C (agentname/rich-cards) node patch step failed — continuing."
const { applyPatch } = require(process.env.PC_PATCH_LIB);
const fs = require('fs');
const file = process.env.WORKER_FILE;
const MARKER = 'PAPERCLIP_TELEGRAM_V4';

// The run-handlers block from any earlier patch iteration (v3, or a prior v4
// dev build) may not match byte-for-byte what's currently on disk — comment
// wording has drifted between iterations before. Capture whatever is
// actually live via regex instead of trusting a hand-copied literal.
let runAnchorLive = null;
try {
  const src0 = fs.readFileSync(file, 'utf8');
  const m = src0.match(/const __enrichAgentName = async \(event\) => \{[\s\S]*?ctx\.events\.on\("agent\.run\.finished"[\s\S]*?\}\);\n?/);
  if (m) runAnchorLive = m[0];
} catch { /* best effort; applyPatch re-reads the file itself and fails soft */ }

// --- Edit 0 (notify-signature): add the optional 5th runTrackingKey param.
const notifySigAnchor =
  '        const notify = async (event, formatter, overrideChatId, overrideTopicId) => {';
const notifySigReplacement =
  '        const notify = async (event, formatter, overrideChatId, overrideTopicId, runTrackingKey) => {';

// --- Edit 0b (notify-edit-in-place): before the anchor/reply-threading logic,
//     try to EDIT a previously-tracked message for this runTrackingKey instead
//     of sending a new one. Falls through to the normal send path (below) if
//     there's nothing tracked yet, the edit fails (deleted/too old), or the
//     tracked message lives in a different chat.
const notifyEditAnchor =
  '            // Issue threading — if we\'ve already sent a message for this entity in this\n' +
  '            // chat+topic, reply to that anchor so all updates about a single entity stack\n' +
  '            // as one Telegram thread on mobile (created → comments → done).\n' +
  '            const anchorKey = event.entityId';
const notifyEditReplacement =
  '            // ' + MARKER + ': same-run edit-in-place — collapse started+finished into one message.\n' +
  '            if (runTrackingKey) {\n' +
  '                try {\n' +
  '                    const tracked = await ctx.state.get({ scopeKind: "instance", stateKey: runTrackingKey });\n' +
  '                    if (tracked?.messageId && tracked.chatId === chatId) {\n' +
  '                        const edited = await editMessage(ctx, token, chatId, tracked.messageId, msg.text, msg.options);\n' +
  '                        if (edited)\n' +
  '                            return;\n' +
  '                    }\n' +
  '                } catch (__rtErr) {\n' +
  '                    ctx.logger.warn("run tracking lookup failed", { error: String(__rtErr) });\n' +
  '                }\n' +
  '            }\n' +
  '            // Issue threading — if we\'ve already sent a message for this entity in this\n' +
  '            // chat+topic, reply to that anchor so all updates about a single entity stack\n' +
  '            // as one Telegram thread on mobile (created → comments → done).\n' +
  '            const anchorKey = event.entityId';

// --- Edit 0c (notify-persist-key): after a fresh send succeeds, remember the
//     message so the next call for the same runTrackingKey can edit it.
const notifyPersistAnchor =
  '            const messageId = await sendMessage(ctx, token, chatId, msg.text, msg.options);\n' +
  '            if (messageId) {\n' +
  '                await ctx.state.set({\n' +
  '                    scopeKind: "instance",\n' +
  '                    stateKey: `msg_${chatId}_${messageId}`,\n' +
  '                }, {';
const notifyPersistReplacement =
  '            const messageId = await sendMessage(ctx, token, chatId, msg.text, msg.options);\n' +
  '            if (messageId) {\n' +
  '                if (runTrackingKey) {\n' +
  '                    await ctx.state.set({ scopeKind: "instance", stateKey: runTrackingKey }, { chatId, messageId, messageThreadId });\n' +
  '                }\n' +
  '                await ctx.state.set({\n' +
  '                    scopeKind: "instance",\n' +
  '                    stateKey: `msg_${chatId}_${messageId}`,\n' +
  '                }, {';

// --- Edit 1: replace bare (fresh install) or previously-patched (upgrade)
//     run handlers with the v4 card layout + edit-in-place tracking key.
const runAnchorStock =
  '        ctx.events.on("agent.run.started", (event) => notify(event, formatAgentRunStarted));\n' +
  '        ctx.events.on("agent.run.finished", (event) => notify(event, formatAgentRunFinished));';

const runReplacement = [
  '        // ' + MARKER + ': ticket+title headline + Agent/Statut/Durée card, edited in place across started->finished.',
  '        const __enrichAgentName = async (event) => {',
  '            const payload = event.payload ?? (event.payload = {});',
  '            const agentId = payload.agentId ?? event.entityId;',
  '            if (agentId && !payload.agentName) {',
  '                try {',
  '                    const agent = await ctx.agents.get(String(agentId), event.companyId);',
  '                    if (agent && agent.name)',
  '                        payload.agentName = agent.name;',
  '                }',
  '                catch { /* best effort */ }',
  '            }',
  '            try {',
  '                if (payload.issueId && !payload.issueTitle) {',
  '                    const __issue = await ctx.issues.get(String(payload.issueId), event.companyId);',
  '                    if (__issue) {',
  '                        payload.issueTitle = __issue.title ?? null;',
  '                        payload.issueIdentifier = __issue.identifier ?? null;',
  '                    }',
  '                }',
  '            }',
  '            catch { /* best effort */ }',
  '            if (payload.durationMs == null && payload.startedAt && payload.finishedAt) {',
  '                const __d = new Date(payload.finishedAt).getTime() - new Date(payload.startedAt).getTime();',
  '                if (Number.isFinite(__d) && __d >= 0)',
  '                    payload.durationMs = __d;',
  '            }',
  '        };',
  '        const __runTrackingKey = (event) => {',
  '            const p = event.payload || {};',
  '            return p.runId ? ("run_msg_" + String(p.runId)) : null;',
  '        };',
  '        const __richRun = (event, opts, emoji, verb, withDuration) => {',
  '            const p = event.payload || {};',
  '            const md = (s) => escapeMarkdownV2(String(s == null ? "" : s));',
  '            const codeEsc = (s) => String(s).replace(/\\\\/g, "\\\\\\\\").replace(/`/g, "\\\\`");',
  '            const agentId = String(p.agentId ?? event.entityId);',
  '            const agentName = String(p.agentName ?? agentId);',
  '            const runId = p.runId ? String(p.runId) : null;',
  '            const baseUrl = opts && opts.baseUrl;',
  '            const prefix = opts && opts.issuePrefix;',
  '            const ext = !!baseUrl && String(baseUrl).startsWith("https://");',
  '            const statusLabel = verb === "started" ? "Démarré" : verb === "failed" ? "Échoué" : "Terminé";',
  '            let headline;',
  '            if (p.issueIdentifier) {',
  '                const id = String(p.issueIdentifier);',
  '                const idtxt = (prefix && baseUrl) ? ("[" + md(id) + "](" + baseUrl + "/" + prefix + "/issues/" + id + ")") : md(id);',
  '                const ttl = p.issueTitle ? (" " + md("—") + " " + md(String(p.issueTitle).slice(0, 140))) : "";',
  '                headline = md(emoji) + " *" + idtxt + "*" + ttl;',
  '            }',
  '            else if (p.issueTitle) {',
  '                headline = md(emoji) + " *Run*" + " " + md("—") + " " + md(String(p.issueTitle).slice(0, 140));',
  '            }',
  '            else {',
  '                headline = md(emoji) + " *Run*";',
  '            }',
  '            const rows = [["👤", "Agent", agentName], ["📊", "Statut", statusLabel]];',
  '            if (withDuration && typeof p.durationMs === "number" && p.durationMs > 0) {',
  '                const s = Math.round(p.durationMs / 1000);',
  '                const dt = s < 60 ? (s + "s") : (s < 3600 ? (Math.floor(s / 60) + "m " + (s % 60) + "s") : (Math.floor(s / 3600) + "h " + Math.floor((s % 3600) / 60) + "m"));',
  '                rows.push(["⏱", "Durée", dt]);',
  '            }',
  '            if (p.error) {',
  '                rows.push(["⚠️", "Erreur", String(p.error).slice(0, 200)]);',
  '            }',
  '            const labelWidth = Math.max(...rows.map((r) => r[1].length));',
  '            const cardLines = ["─".repeat(17)].concat(rows.map((r) => r[0] + " " + r[1].padEnd(labelWidth, " ") + "  " + r[2]));',
  '            const card = "```\\n" + codeEsc(cardLines.join("\\n")) + "\\n```";',
  '            const lines = [headline, card];',
  '            const buttons = [];',
  '            if (ext) {',
  '                const url = runId ? (baseUrl + "/agents/" + agentId + "/runs/" + runId) : (baseUrl + "/agents/" + agentId);',
  '                buttons.push({ text: "View Run ↗", url });',
  '            }',
  '            const keyboard = buttons.length > 0 ? [buttons] : [];',
  '            if (ext && p.issueIdentifier && prefix) {',
  '                keyboard.push([{ text: "Open " + String(p.issueIdentifier) + " ↗", url: baseUrl + "/" + prefix + "/issues/" + String(p.issueIdentifier) }]);',
  '            }',
  '            return { text: lines.join("\\n"), options: { parseMode: "MarkdownV2", disableNotification: true, ...(keyboard.length > 0 ? { inlineKeyboard: keyboard } : {}) } };',
  '        };',
  '        const __formatRunStartedRich = (event, opts) => __richRun(event, opts, "🚀", "started", false);',
  '        const __formatRunFinishedRich = (event, opts) => __richRun(event, opts, "✅", "completed", true);',
  '        const __formatRunFailedRich = (event, opts) => __richRun(event, opts, "❌", "failed", true);',
  '        ctx.events.on("agent.run.started", async (event) => { await __enrichAgentName(event); await notify(event, __formatRunStartedRich, undefined, undefined, __runTrackingKey(event)); });',
  '        ctx.events.on("agent.run.finished", async (event) => { await __enrichAgentName(event); await notify(event, __formatRunFinishedRich, undefined, undefined, __runTrackingKey(event)); });',
].join('\n');

// --- Edit 2 (OPTIONAL): fix resolveIssueLinksOpts to fall back to the
//     PAPERCLIP_APP_URL env var so issue links are HTTPS even without plugin config.
const optsAnchor =
  '            return { baseUrl: publicUrl, issuePrefix: prefix || undefined };';
const optsReplacement =
  '            const effectiveUrl = publicUrl.startsWith("https://") ? publicUrl : (process.env.PAPERCLIP_APP_URL || publicUrl);\n' +
  '            return { baseUrl: effectiveUrl, issuePrefix: prefix || undefined };';

// --- Edit 3 (OPTIONAL): wire __enrichAgentName + the v4 rich failed formatter
//     + runTrackingKey into the error handler (covers both a fresh install and
//     a worker.js already upgraded by an earlier iteration of this script that
//     only wired enrichment without the rich formatter).
const failedAnchorStock =
  '            ctx.events.on("agent.run.failed", (event) => notify(event, formatAgentError, config.errorsChatId, config.errorsTopicId));';
const failedAnchorEnriched =
  '            ctx.events.on("agent.run.failed", async (event) => { await __enrichAgentName(event); await notify(event, formatAgentError, config.errorsChatId, config.errorsTopicId); });';
const failedReplacement =
  '            ctx.events.on("agent.run.failed", async (event) => { await __enrichAgentName(event); await notify(event, __formatRunFailedRich, config.errorsChatId, config.errorsTopicId, __runTrackingKey(event)); });';

applyPatch({
  file, marker: MARKER, mode: 'soft', prefix: 'telegram-worker-patches',
  edits: [
    { label: 'notify-signature', anchor: notifySigAnchor, replacement: notifySigReplacement, optional: true },
    { label: 'notify-edit-in-place', anchor: notifyEditAnchor, replacement: notifyEditReplacement, optional: true },
    { label: 'notify-persist-key', anchor: notifyPersistAnchor, replacement: notifyPersistReplacement, optional: true },
    { label: 'run-handlers (fresh install)', anchor: runAnchorStock, replacement: runReplacement, optional: true },
    ...(runAnchorLive ? [{ label: 'run-handlers (upgrade from earlier patch)', anchor: runAnchorLive, replacement: runReplacement, optional: true }] : []),
    { label: 'resolve-opts', anchor: optsAnchor, replacement: optsReplacement, optional: true },
    { label: 'agent.run.failed (fresh install)', anchor: failedAnchorStock, replacement: failedReplacement, optional: true },
    { label: 'agent.run.failed (upgrade from earlier patch)', anchor: failedAnchorEnriched, replacement: failedReplacement, optional: true },
  ],
});
NODE

# ═════════════════════════════════════════════════════════════════════════
# Section D — shared self-heal, runs once regardless of what A/C did above.
# Unifies the two self-heals this project previously carried separately for
# the same "duplicate notify() declaration" failure mode (the old agentname
# script's JS-side log-only check, the old agent-topics script's bash-side
# sed fix) into one: repair the common back-to-back-duplicate shape (works
# for either notify arity), then warn loudly if a duplicate still remains.
# ═════════════════════════════════════════════════════════════════════════
if grep -qE 'const notify = async \([^)]*\) => \{[[:space:]]*const notify = async \([^)]*\) => \{' "$WORKER"; then
  sed -i -E 's/(const notify = async \([^)]*\) => \{)[[:space:]]*const notify = async \([^)]*\) => \{/\1/' "$WORKER"
  pc_log "worker.js: duplicate notify() declaration corrigée"
fi
notify_decl_count="$(grep -cE 'const notify = async \(event, formatter, overrideChatId, overrideTopicId' "$WORKER")"
if [ "$notify_decl_count" -gt 1 ]; then
  pc_warn "FATAL: $notify_decl_count notify() declarations found post-patch — plugin will likely fail to load. Investigate before next restart."
fi

pc_log "telegram worker patches: agent-topics + agentname/rich-cards pass complete"
exit 0
