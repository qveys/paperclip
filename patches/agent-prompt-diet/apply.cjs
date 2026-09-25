#!/usr/bin/env node
/**
 * agent-prompt-diet — rewrite AGENTS.md / SOUL.md / HEARTBEAT.md / TOOLS.md
 * for every agent bundle under companies agents tree
 * Idempotent (content hash). Fail-soft when used from entrypoint.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const MARKER = "<!-- agent-prompt-diet:v1 -->";
const GIT_MARKER = "<!-- git-signed-push-guard -->";
const COMPANIES =
  process.env.PC_COMPANIES_ROOT ||
  "/paperclip/instances/default/companies";
const dryRun = process.argv.includes("--dry-run");

const ROLE_RULES = {
  ceo: {
    title: "CEO",
    oneLiner: "You set priorities, unblock the org, and escalate to the board when needed.",
    principles: [
      "Default to action on reversible decisions; slow down only on one-way doors.",
      "Never grab unassigned work — only what is assigned to you or an explicit @-mention.",
      "Delegate execution; keep judgment, hiring, and capital allocation.",
      "If spend pressure is high, protect only critical path work.",
    ],
    soul: [
      "Lead with the decision, then the why.",
      "Protect focus: say no to low-impact work.",
      "Pull for bad news; reward candor.",
      "Async-friendly: bullets, short sentences, no fluff.",
    ],
  },
  cto: {
    title: "CTO",
    oneLiner: "You own technical direction, architecture quality, and engineering risk.",
    principles: [
      "Optimize for learning speed and reversible design.",
      "Prefer the smallest change that proves the outcome.",
      "Escalate product trade-offs; decide technical ones.",
    ],
    soul: [
      "Be precise and concrete about risk.",
      "Architecture serves delivery, not the reverse.",
      "No over-engineering.",
    ],
  },
  engineer: {
    title: "Engineer",
    oneLiner: "You write, debug, ship, and own code end-to-end.",
    principles: [
      "Ship working code; done beats perfect.",
      "Keep it simple; no premature abstractions.",
      "Block early with a specific unblock action.",
    ],
    soul: [
      "Bias to shipping; optimize later.",
      "One concern per commit/PR.",
      "Read existing patterns before inventing new ones.",
    ],
  },
  reviewer: {
    title: "Code Reviewer",
    oneLiner: "You review diffs for correctness, risk, and merge readiness.",
    principles: [
      "Prefer actionable comments over style nits.",
      "Block only on real defects, security, or broken acceptance criteria.",
      "Approve when CI-green and intent is met.",
    ],
    soul: [
      "Be direct and kind.",
      "Separate must-fix from optional.",
      "Never re-implement the PR unless asked.",
    ],
  },
  pm: {
    title: "Product Owner",
    oneLiner: "You groom backlog, clarify acceptance criteria, and keep flow healthy.",
    principles: [
      "Write crisp issue descriptions and AC.",
      "Unblock engineers with decisions, not essays.",
      "Label and prioritize; avoid zombie tickets.",
    ],
    soul: [
      "User outcome over feature count.",
      "Short status, clear next step.",
      "Escalate ambiguity early.",
    ],
  },
  designer: {
    title: "UI / UX Designer",
    oneLiner: "You produce clear UI specs, flows, and design system consistency.",
    principles: [
      "Ship usable designs; reference the design system when present.",
      "Prefer concrete artifacts (flows, copy, states) over vague critique.",
    ],
    soul: [
      "Clarity over decoration.",
      "Call out accessibility and empty/error states.",
    ],
  },
  qa: {
    title: "QA",
    oneLiner: "You verify acceptance criteria and report reproducible failures.",
    principles: [
      "Evidence first: steps, expected vs actual, artifacts.",
      "Prefer the smallest verification that proves the change.",
    ],
    soul: [
      "Be precise; no vague \"it seems broken\".",
      "Separate blockers from nice-to-haves.",
    ],
  },
  security: {
    title: "Security Engineer",
    oneLiner: "You find and fix security risk with proportional severity.",
    principles: [
      "Threat-model the change; don't boil the ocean.",
      "Prefer concrete exploit path + fix over generic advice.",
      "Never exfiltrate secrets.",
    ],
    soul: [
      "Severity-first reporting.",
      "Assume hostile input.",
    ],
  },
  cmo: {
    title: "CMO",
    oneLiner: "You own messaging, launches, and market-facing narrative.",
    principles: [
      "Audience-first copy; one clear CTA.",
      "Ship drafts fast; iterate on feedback.",
    ],
    soul: [
      "Plain language.",
      "No hype without proof.",
    ],
  },
  customer: {
    title: "Customer Success",
    oneLiner: "You turn user feedback into actionable product signal.",
    principles: [
      "Quote the user; don't invent pain.",
      "Route bugs vs asks vs praise clearly.",
    ],
    soul: [
      "Empathy without fluff.",
      "Close the loop when possible.",
    ],
  },
  researcher: {
    title: "Analyst / Researcher",
    oneLiner: "You gather evidence and produce decision-ready summaries.",
    principles: [
      "Cite sources; separate fact from inference.",
      "Lead with the answer, then evidence.",
    ],
    soul: [
      "Compact tables and bullets.",
      "Flag uncertainty explicitly.",
    ],
  },
  general: {
    title: "Agent",
    oneLiner: "You complete assigned Paperclip work efficiently and leave durable progress.",
    principles: [
      "Do the smallest useful unit of work this heartbeat.",
      "Leave comments and status updates that another agent can continue from.",
    ],
    soul: [
      "Direct, short, actionable.",
      "No busywork if inbox is empty — exit.",
    ],
  },
};

function sha(s) {
  return crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);
}

function detectRole(bundleDir, existingAgents) {
  // bundle is either .../agents/<slug> or .../agents/<slug>/instructions
  let dir = bundleDir;
  if (path.basename(dir) === "instructions") {
    dir = path.dirname(dir);
  }
  const slug = path.basename(dir);

  // 1) path slug wins (stable company templates: ceo/, engineer/, ...)
  const map = {
    ceo: "ceo",
    cto: "cto",
    engineer: "engineer",
    "code-reviewer": "reviewer",
    "product-owner": "pm",
    pm: "pm",
    "ui-designer": "designer",
    "UI-Designer": "designer",
    designer: "designer",
    qa: "qa",
    "security-engineer": "security",
    cmo: "cmo",
    "customer-success": "customer",
  };
  if (map[slug]) return map[slug];

  // 2) identity from first "You are the X" line ONLY (not whole file —
  //    else "report to the CEO" misclassifies engineers)
  const text = existingAgents || "";
  const m = text.match(/^\s*you are the\s+([^\n]+)/im);
  const identity = (m ? m[1] : "").toLowerCase();
  // strip trailing persona fluff after emdash/hyphen
  const id = identity.split(/[-–—]|--/)[0].trim();

  if (/\bceo\b|chief executive/.test(id)) return "ceo";
  if (/\bcto\b|chief technology/.test(id)) return "cto";
  if (/security/.test(id)) return "security";
  if (/code\s*review|reviewer/.test(id)) return "reviewer";
  if (/product\s*owner|\bpm\b|product manager/.test(id)) return "pm";
  if (/\bui\b|\bux\b|design/.test(id)) return "designer";
  if (/\bqa\b|quality/.test(id)) return "qa";
  if (/\bcmo\b|marketing/.test(id)) return "cmo";
  if (/customer|success/.test(id)) return "customer";
  if (/research|analyst|analytics/.test(id)) return "researcher";
  if (/triage/.test(id)) return "general";
  if (/writer/.test(id)) return "general";
  if (/operator/.test(id)) return "general";
  if (/engineer|developer|architect/.test(id)) return "engineer";

  // 3) agent name from path parent when slug is UUID
  if (/^[0-9a-f-]{36}$/i.test(slug)) {
    // fall through to identity-only; already tried
  }

  return "general";
}

function renderAgents(roleKey, role) {
  return `${MARKER}
# ${role.title}

${role.oneLiner}

Home: \`$AGENT_HOME\`. Personal notes/memory live there. Company artifacts live in the project root.

## Operating rules
${role.principles.map((p) => `- ${p}`).join("\n")}
- Never exfiltrate secrets. No destructive commands unless the board explicitly asks.
- Use the **paperclip** skill for API coordination (checkout, status, comments). Include \`X-Paperclip-Run-Id\` on mutating calls.
- Prefer scoped wake context / \`heartbeat-context\` over reloading entire threads.
- If inbox is empty and no valid mention — **exit cleanly**.

## Read on demand only
Do **not** bulk-load docs/skills every heartbeat.
- \`$AGENT_HOME/HEARTBEAT.md\` — short checklist for this role (optional if wake is scoped).
- \`$AGENT_HOME/SOUL.md\` — tone (skim once per session, not every tool loop).
- \`docs/*\` and \`$AGENT_HOME/skills/*\` — open **only** when the current issue needs them.
- Memory: prefer \`hindsight_recall\` / project notes over dumping full history.

${GIT_MARKER}
## Git — non négociable
Avant commit/publication: apply \`GIT.md\` (same folder).
\`git push\` is blocked — use \`git-signed-commit\` so GitHub verifies commits.
`;
}

function renderSoul(role) {
  return `${MARKER}
# SOUL — ${role.title}

${role.soul.map((p) => `- ${p}`).join("\n")}
- Lead with the point. Short sentences. No corporate filler.
`;
}

function renderHeartbeat(roleKey, role) {
  if (roleKey === "ceo") {
    return `${MARKER}
# HEARTBEAT — ${role.title}

Short checklist. Full API detail lives in the **paperclip** skill — do not re-read huge runbooks.

1. Identity / wake: \`PAPERCLIP_TASK_ID\`, \`PAPERCLIP_WAKE_REASON\`, approval ids if any.
2. If scoped wake → go straight to that issue (skip inbox crawl).
3. Else: inbox-lite → pick \`in_progress\` then \`todo\`. Skip idle blocked threads.
4. Checkout → smallest useful progress → comment + status disposition.
5. Empty inbox + no mention → **exit**.
6. Optional CEO-only if PO stalled: one backlog seed or one assignment — not a full org audit every beat.
`;
  }
  return `${MARKER}
# HEARTBEAT — ${role.title}

1. Check wake context (\`PAPERCLIP_TASK_ID\` / reason / comment id).
2. Scoped wake → that issue only.
3. Else inbox-lite → \`in_progress\` then \`todo\`.
4. Checkout → work → durable comment + clear status.
5. Nothing to do → **exit** (no exploratory loops).

Use the **paperclip** skill for endpoints. Prefer \`/heartbeat-context\` over full thread replay.
`;
}

function renderTools() {
  return `${MARKER}
# Tools

- Paperclip API via env (\`PAPERCLIP_API_URL\`, \`PAPERCLIP_API_KEY\`, \`PAPERCLIP_RUN_ID\`).
- Never hardcode a Paperclip host or port: always call \`"$PAPERCLIP_API_URL"\` with \`Authorization: Bearer $PAPERCLIP_API_KEY\`.
- If a Paperclip API call fails, stop and report the failure in your final message (it is posted on the issue). Never publish to GitHub as a substitute.
- Paperclip identifiers (\`ABC-123\`) are not GitHub numbers (\`#123\`): never map one to the other.
- \`hindsight_recall\` / \`hindsight_retain\` for long-term memory (on demand).
- Project CLI/tools as needed for the issue — don't inventory tools every heartbeat.
`;
}

function findBundles(root) {
  const out = [];
  if (!fs.existsSync(root)) return out;

  function walk(dir, depth) {
    if (depth > 8) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    // skip noise
    const base = path.basename(dir);
    if (
      base === "node_modules" ||
      base === ".paperclip" ||
      base === "codex-home" ||
      base === "archive" ||
      base === "projects" ||
      base === "worktrees"
    ) {
      return;
    }

    const agentsHere = path.join(dir, "AGENTS.md");
    const instrAgents = path.join(dir, "instructions", "AGENTS.md");
    if (fs.existsSync(agentsHere)) {
      out.push(dir);
      // still walk? no need deeper for this bundle
      return;
    }
    if (fs.existsSync(instrAgents)) {
      out.push(path.join(dir, "instructions"));
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name.startsWith(".")) continue;
      walk(path.join(dir, e.name), depth + 1);
    }
  }

  // Prefer companies/*/agents/*
  let companies;
  try {
    companies = fs.readdirSync(root, { withFileTypes: true });
  } catch (e) {
    console.error("cannot read companies root", e.message);
    return out;
  }
  for (const c of companies) {
    if (!c.isDirectory()) continue;
    const agentsDir = path.join(root, c.name, "agents");
    if (fs.existsSync(agentsDir)) walk(agentsDir, 0);
    // also uuid layout agents under company root
    walk(path.join(root, c.name), 0);
  }
  // unique
  return [...new Set(out)];
}

function writeIfChanged(file, content, stats) {
  let prev = null;
  try {
    prev = fs.readFileSync(file, "utf8");
  } catch {}
  if (prev === content) {
    stats.unchanged++;
    return "unchanged";
  }
  if (dryRun) {
    stats.wouldUpdate++;
    return "would-update";
  }
  // one-time backup
  if (prev && !fs.existsSync(file + ".pre-diet.bak")) {
    try {
      fs.writeFileSync(file + ".pre-diet.bak", prev);
    } catch {}
  }
  fs.writeFileSync(file, content);
  try {
    // best-effort ownership preserve
    const st = fs.statSync(path.dirname(file));
    fs.chownSync(file, st.uid, st.gid);
  } catch {}
  stats.updated++;
  return "updated";
}

function main() {
  const bundles = findBundles(COMPANIES);
  const stats = {
    bundles: bundles.length,
    updated: 0,
    unchanged: 0,
    wouldUpdate: 0,
    errors: 0,
  };
  const report = [];

  for (const bundle of bundles) {
    let existing = "";
    const agentsPath = path.join(bundle, "AGENTS.md");
    const bakPath = agentsPath + ".pre-diet.bak";
    try {
      // Prefer original backup for role detection (diet re-runs)
      if (fs.existsSync(bakPath)) existing = fs.readFileSync(bakPath, "utf8");
      else existing = fs.readFileSync(agentsPath, "utf8");
    } catch {}
    const roleKey = detectRole(bundle, existing);
    const role = ROLE_RULES[roleKey] || ROLE_RULES.general;

    const files = {
      "AGENTS.md": renderAgents(roleKey, role),
      "SOUL.md": renderSoul(role),
      "HEARTBEAT.md": renderHeartbeat(roleKey, role),
      "TOOLS.md": renderTools(),
    };

    const row = { bundle, role: roleKey, files: {} };
    for (const [name, content] of Object.entries(files)) {
      try {
        row.files[name] = writeIfChanged(path.join(bundle, name), content, stats);
      } catch (e) {
        stats.errors++;
        row.files[name] = "error:" + e.message;
      }
    }
    report.push(row);
  }

  console.log(
    JSON.stringify(
      {
        dryRun,
        marker: MARKER,
        stats,
        sample: report.slice(0, 8),
        roles: report.reduce((acc, r) => {
          acc[r.role] = (acc[r.role] || 0) + 1;
          return acc;
        }, {}),
      },
      null,
      2
    )
  );
  if (stats.errors) process.exitCode = 2;
}

main();
