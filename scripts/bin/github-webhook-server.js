#!/usr/bin/env node
// github-webhook-server.js
// Tiny HTTP server (stdlib only) that receives GitHub App webhooks on port 3101,
// verifies the HMAC signature, then wakes up the Paperclip agent assigned to
// the PR's linked issue.
//
// Exposed via Traefik at POST https://paperclip.qveys.cloud/webhooks/github
// (priority-20 router → port 3101, bypasses Cloudflare Access for that path).
// Started at boot by entrypoint.d/60-github-webhook-server.bg.sh
'use strict';

const http   = require('http');
const crypto = require('crypto');

const PORT         = parseInt(process.env.GITHUB_WEBHOOK_PORT || '3101');
const SECRET       = process.env.GITHUB_WEBHOOK_SECRET || '';
const PC_API       = process.env.PAPERCLIP_RUNTIME_API_URL || 'http://localhost:3100';
// PAPERCLIP_BOARD_KEY = board/user API key (can wakeup any agent).
// PAPERCLIP_API_KEY   = operator agent key (read-only fallback: used only for search).
const PC_BOARD_KEY = process.env.PAPERCLIP_BOARD_KEY;
const PC_KEY       = process.env.PAPERCLIP_API_KEY;
const CO_ID        = process.env.PAPERCLIP_COMPANY_ID;

// Bot logins whose events must be completely ignored (case-sensitive)
const BOT_LOGINS = new Set(['my-paperclip-company[bot]']);

// PR events worth waking the agent for
const PR_ACTIONS = new Set(['review_requested', 'closed', 'merged', 'reopened', 'ready_for_review', 'synchronize']);

// Events that must NOT reopen a done issue
const NO_REOPEN_REASONS = new Set(['pull_request.synchronize']);

// Debounce window: events arriving within this window are batched into one comment + one wakeup
const DEBOUNCE_MS = 60_000;

const log = (...a) => console.log(`[gh-webhook ${new Date().toISOString()}]`, ...a);

// ── Delivery deduplication (prevents GitHub retries from double-waking) ────────
// In-memory map: deliveryId → timestamp. TTL = 10 min.
const seenDeliveries = new Map();
const DELIVERY_TTL_MS = 10 * 60 * 1000;

function isDuplicateDelivery(deliveryId) {
  if (!deliveryId) return false;
  const now = Date.now();
  for (const [id, ts] of seenDeliveries) {
    if (now - ts > DELIVERY_TTL_MS) seenDeliveries.delete(id);
  }
  if (seenDeliveries.has(deliveryId)) return true;
  seenDeliveries.set(deliveryId, now);
  return false;
}

// ── HMAC verification ─────────────────────────────────────────────────────────

function verifySignature(rawBody, sigHeader) {
  if (!SECRET) return true; // no secret configured → accept all (dev mode)
  if (!sigHeader?.startsWith('sha256=')) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', SECRET).update(rawBody).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(sigHeader), Buffer.from(expected));
  } catch {
    return false;
  }
}

// ── Paperclip API helpers (localhost → no proxy) ──────────────────────────────

async function pcGet(path) {
  const r = await fetch(`${PC_API}/api${path}`, {
    headers: { Authorization: `Bearer ${PC_KEY}`, 'Content-Type': 'application/json' },
  });
  if (!r.ok) throw new Error(`${r.status} GET ${path}`);
  return r.json();
}

async function pcPost(path, body, { boardKey = false } = {}) {
  const token = boardKey ? PC_BOARD_KEY : PC_KEY;
  const r = await fetch(`${PC_API}/api${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) { const t = await r.text(); throw new Error(`${r.status} POST ${path}: ${t.slice(0,200)}`); }
  return r.json().catch(() => ({}));
}

async function pcPatch(path, body) {
  const r = await fetch(`${PC_API}/api${path}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${PC_BOARD_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) { const t = await r.text(); throw new Error(`${r.status} PATCH ${path}: ${t.slice(0,200)}`); }
  return r.json().catch(() => ({}));
}

// ── Find the Paperclip issue linked to this PR URL ────────────────────────────

async function findIssueForPr(prUrl) {
  if (!PC_KEY || !CO_ID) return null;
  // Full-text search: agents post "PR: <url>" as a comment when opening PR
  const q = encodeURIComponent(prUrl);
  const r = await pcGet(`/companies/${CO_ID}/issues?q=${q}&limit=20`);
  const issues = r.issues || r.data || (Array.isArray(r) ? r : []);
  return issues.find(i => i.assigneeAgentId) || null;
}

// ── Build context block (what happened) and directive block (what to do) ──────

function buildContext(eventType, payload, prUrl) {
  if (eventType === 'issue_comment') {
    const author = payload.comment?.user?.login || 'unknown';
    const body   = payload.comment?.body || '';
    const url    = payload.comment?.html_url || prUrl;
    return `**Nouveau commentaire GitHub sur la PR** par @${author}\n\n> ${body.split('\n').join('\n> ')}\n\n[Voir le commentaire](${url})`;

  } else if (eventType === 'pull_request_review') {
    const author = payload.review?.user?.login || 'unknown';
    const state  = payload.review?.state || 'submitted';
    const body   = payload.review?.body || '';
    const url    = payload.review?.html_url || prUrl;
    const label  = { approved: '✅ Approuvée', changes_requested: '🔴 Modifications demandées', commented: '💬 Commentaire' }[state] || state;
    const extra  = body ? `\n\n> ${body.split('\n').join('\n> ')}` : '';
    return `**Review GitHub : ${label}** par @${author}${extra}\n\n[Voir la review](${url})`;

  } else if (eventType === 'pull_request') {
    const action = payload.action;
    const author = payload.sender?.login || 'unknown';
    const title  = payload.pull_request?.title || '';
    const labels = { closed: '🔴 Fermée', merged: '🟣 Mergée', reopened: '🔄 Rouverte', ready_for_review: '👀 Prête pour review', synchronize: '🔀 Nouveaux commits' };
    const label  = labels[action] || action;
    return `**PR ${label}** par @${author} — [${title}](${prUrl})`;

  }
  return `**Événement GitHub : ${eventType}** sur [${prUrl}](${prUrl})`;
}

// Returns a directive block telling the agent what to do next.
// Returns empty string for terminal PR events (merged/closed) where no action is needed.
function buildDirective(eventType, payload, prUrl) {
  if (eventType === 'pull_request' && ['closed', 'merged'].includes(payload.action)) {
    return '';
  }

  const reviewState = payload.review?.state;
  let urgency;
  if (reviewState === 'changes_requested') {
    urgency = '🔴 **Des modifications sont explicitement demandées sur la PR.**';
  } else if (reviewState === 'approved') {
    urgency = '✅ **La PR est approuvée — vérifie si elle est mergeable.**';
  } else {
    urgency = '👀 **Un retour a été laissé sur la PR.**';
  }

  // Commands with the actual PR URL substituted — agent must run them, not assume state
  return `\n\n---\n${urgency}\n\n` +
    `⚠️ **Tu NE peux PAS décider de l'action à prendre sans avoir d'abord exécuté les commandes ci-dessous. Ne te base PAS sur git log, HEAD ou le contexte en mémoire — lis la PR maintenant.**\n\n` +
    `**Étape 1 — lire l'état global et les reviews**\n` +
    `\`\`\`bash\n` +
    `gh pr view ${prUrl}\n` +
    `gh pr view ${prUrl} --json reviewDecision,reviews --jq '[.reviews[] | {state,author:.author.login,body}]'\n` +
    `\`\`\`\n\n` +
    `**Étape 2 — lire tous les commentaires inline (threads de review sur le code)**\n` +
    `\`\`\`bash\n` +
    `REPO=$(gh pr view ${prUrl} --json headRepository --jq '.headRepository.nameWithOwner')\n` +
    `NUM=$(gh pr view ${prUrl} --json number --jq '.number')\n` +
    `gh api repos/$REPO/pulls/$NUM/comments --jq '[.[] | {path,line,body,author:.user.login}]'\n` +
    `\`\`\`\n\n` +
    `**Étape 3 — traiter chaque point de feedback**\n` +
    `- Thread de code à modifier → applique le changement, commit avec \`git-signed-commit\`, réponds dans le thread en précisant ce qui a été corrigé\n` +
    `- Question ou commentaire général → réponds directement dans GitHub (\`gh pr comment ${prUrl} --body "..."\`)\n` +
    `- Blocage insurmontable → explique ici dans le ticket Paperclip\n\n` +
    `**Étape 4 — une fois tous les threads traités**, re-demande une review (\`gh pr edit ${prUrl} --add-reviewer <login>\`)\n\n` +
    `**Tu ne peux marquer l'issue comme done que lorsque \`reviewDecision\` est \`APPROVED\` et qu'il ne reste aucun thread ouvert.**`;
}

// Build the comment body for a batch of events (1 or more)
function buildBatchedComment(events) {
  if (events.length === 1) {
    const { eventType, payload, prUrl } = events[0];
    return buildContext(eventType, payload, prUrl) + buildDirective(eventType, payload, prUrl);
  }

  // Multiple events: list all context blocks, then a single directive from the last event
  const contexts = events.map(({ eventType, payload, prUrl }, i) =>
    `### Événement ${i + 1}\n${buildContext(eventType, payload, prUrl)}`
  ).join('\n\n---\n\n');

  const last = events[events.length - 1];
  return `**${events.length} événements GitHub regroupés**\n\n${contexts}` +
    buildDirective(last.eventType, last.payload, last.prUrl);
}

// ── Debounce batch: per-issue pending queue ───────────────────────────────────
// issueId → { timer, issue, events: [{eventType, payload, prUrl, reason}] }
const pendingByIssue = new Map();

const TERMINAL_STATUSES = new Set(['done', 'cancelled', 'archived']);

async function flushBatch(issueId) {
  const pending = pendingByIssue.get(issueId);
  pendingByIssue.delete(issueId);
  if (!pending || !pending.events.length) return;

  const { issue, events } = pending;
  // Use the last event to determine the action reason and prUrl
  const { prUrl, reason } = events[events.length - 1];

  if (!PC_BOARD_KEY) {
    log('WARN PAPERCLIP_BOARD_KEY non défini — réveil impossible (board key requise pour wakeup cross-agent)');
    return;
  }

  const commentBody = buildBatchedComment(events);
  try {
    await pcPost(`/issues/${issue.id}/comments`, { body: commentBody }, { boardKey: true });
    log(`✓ commentaire posté sur ${issue.identifier} (${events.length} événement(s) groupé(s))`);
  } catch (e) {
    log('WARN comment failed:', e.message);
  }

  // Reopen the issue if it reached a terminal status — but NOT for synchronize
  if (TERMINAL_STATUSES.has(issue.status)) {
    if (NO_REOPEN_REASONS.has(reason)) {
      log(`↷ issue ${issue.identifier} est ${issue.status} mais raison=${reason} → pas de réouverture (push agent)`);
      return;
    }
    try {
      await pcPatch(`/issues/${issue.id}`, { status: 'in_progress' });
      log(`✓ issue ${issue.identifier} rouverte (était ${issue.status})`);
    } catch (e) {
      log('WARN reopen failed:', e.message);
    }
  }

  log(`→ réveil agent ${issue.assigneeAgentId} (${reason}) — ${prUrl}`);
  try {
    await pcPost(`/agents/${issue.assigneeAgentId}/wakeup`, {
      source: 'automation',
      triggerDetail: 'callback',
      reason: `GitHub PR event: ${reason}`,
      payload: { prUrl, issueId: issue.id, event: reason },
    }, { boardKey: true });
    log(`✓ wakeup envoyé → agent ${issue.assigneeAgentId}`);
  } catch (e) {
    log('WARN wakeup failed:', e.message);
  }
}

// ── Process GitHub event (async, after 200 is sent) ──────────────────────────

async function processEvent(eventType, payload) {
  // Ignore all events triggered by our own bot
  const senderLogin = payload.sender?.login || '';
  if (BOT_LOGINS.has(senderLogin) || senderLogin.endsWith('[bot]') && BOT_LOGINS.has(senderLogin)) {
    log(`SKIP event from bot ${senderLogin} (${eventType})`);
    return;
  }

  let prUrl = null;
  let reason = eventType;

  if (eventType === 'pull_request') {
    const action = payload.action;
    if (!PR_ACTIONS.has(action) && action !== 'synchronize') return;
    prUrl  = payload.pull_request?.html_url;
    reason = `pull_request.${action}`;

  } else if (eventType === 'pull_request_review') {
    if (payload.action !== 'submitted') return;
    prUrl  = payload.pull_request?.html_url;
    reason = `review.${payload.review?.state || 'submitted'}`;

  } else if (eventType === 'issue_comment') {
    if (payload.action !== 'created') return;
    if (!payload.issue?.pull_request) return; // comment on issue, not PR
    prUrl  = payload.issue.pull_request.html_url;
    reason = 'pr_comment';

  } else {
    return; // unhandled event type
  }

  if (!prUrl) return;

  let issue;
  try {
    issue = await findIssueForPr(prUrl);
  } catch (e) {
    log('WARN findIssue:', e.message);
    return;
  }

  if (!issue) {
    log(`no Paperclip issue found for PR ${prUrl} — skipping`);
    return;
  }

  // Buffer the event and (re)start the debounce timer
  if (pendingByIssue.has(issue.id)) {
    const pending = pendingByIssue.get(issue.id);
    clearTimeout(pending.timer);
    pending.events.push({ eventType, payload, prUrl, reason });
    pending.timer = setTimeout(() => flushBatch(issue.id), DEBOUNCE_MS);
    log(`⏱ event buffered (${pending.events.length} en attente) pour ${issue.identifier}`);
  } else {
    const pending = { issue, events: [{ eventType, payload, prUrl, reason }], timer: null };
    pending.timer = setTimeout(() => flushBatch(issue.id), DEBOUNCE_MS);
    pendingByIssue.set(issue.id, pending);
    log(`⏱ debounce démarré (${DEBOUNCE_MS}ms) pour ${issue.identifier} — ${reason}`);
  }
}

// ── HTTP server ───────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/webhooks/github') {
    res.writeHead(404).end();
    return;
  }

  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const rawBody = Buffer.concat(chunks);
    const sig     = req.headers['x-hub-signature-256'];

    if (!verifySignature(rawBody, sig)) {
      log('WARN invalid signature — rejected');
      res.writeHead(401).end('Invalid signature');
      return;
    }

    // Respond 200 immediately so GitHub doesn't time out (10 s limit)
    res.writeHead(200, { 'Content-Type': 'text/plain' }).end('OK');

    const deliveryId = req.headers['x-github-delivery'];
    if (isDuplicateDelivery(deliveryId)) {
      log(`SKIP duplicate delivery ${deliveryId}`);
      return;
    }

    const eventType = req.headers['x-github-event'];
    let payload;
    try { payload = JSON.parse(rawBody.toString('utf8')); }
    catch { return; }

    processEvent(eventType, payload).catch(e => log('WARN processEvent:', e.message));
  });
});

server.listen(PORT, '0.0.0.0', () => {
  log(`listening on port ${PORT} — waiting for GitHub webhooks`);
  if (!SECRET)       log('WARN GITHUB_WEBHOOK_SECRET not set — signature verification disabled');
  if (!PC_KEY)       log('WARN PAPERCLIP_API_KEY not set — issue search will fail');
  if (!PC_BOARD_KEY) log('WARN PAPERCLIP_BOARD_KEY not set — agent wakeup disabled (board key required); set it in .env after creating one in Paperclip UI → Settings → Developer → API Keys');
});

server.on('error', e => { log('FATAL server error:', e.message); process.exit(1); });
