#!/usr/bin/env node
/**
 * Apply agent model policy to all agents in embedded Postgres.
 * Idempotent. Safe to re-run. Fail-soft when called from entrypoint.
 */
const fs = require("fs");
const path = require("path");

const POLICY_PATH =
  process.env.PC_MODEL_POLICY_PATH ||
  path.join(__dirname, "policy.json");

function loadPolicy() {
  const raw = fs.readFileSync(POLICY_PATH, "utf8");
  return JSON.parse(raw);
}

function resolvePg() {
  // pg is declared in this patch's own package.json and installed into
  // patches/agent-model-policy/node_modules at image build time. The previous
  // hardcoded paths pointed at a global paperclipai install that no longer
  // exists (paperclipai is a compiled binary now).
  return require("pg");
}

function pickByTitle(policy, name, title, role) {
  const hay = `${name || ""} ${title || ""} ${role || ""}`;
  for (const rule of policy.byTitlePattern || []) {
    const re = new RegExp(rule.match, "i");
    if (re.test(hay)) return rule;
  }
  return null;
}

function resolveTarget(policy, agent) {
  const adapter = agent.adapter_type || "";
  if ((policy.skipAdapters || []).includes(adapter)) {
    return { skip: true, reason: `adapter ${adapter}` };
  }

  const titleHit = pickByTitle(policy, agent.name, agent.title, agent.role);
  if (titleHit) {
    if (titleHit.skip) return { skip: true, reason: titleHit.reason || "title pattern skip" };
    return {
      model: titleHit.model,
      maxTurnsPerRun: titleHit.maxTurnsPerRun ?? policy.defaults.maxTurnsPerRun,
      source: `title:${titleHit.match}`,
    };
  }

  const roleRule = (policy.byRole && policy.byRole[agent.role]) || null;
  if (roleRule) {
    if (roleRule.skip) return { skip: true, reason: roleRule.reason || `role ${agent.role}` };
    return {
      model: roleRule.model || policy.defaults.model,
      maxTurnsPerRun: roleRule.maxTurnsPerRun ?? policy.defaults.maxTurnsPerRun,
      source: `role:${agent.role}`,
    };
  }

  return {
    model: policy.defaults.model,
    maxTurnsPerRun: policy.defaults.maxTurnsPerRun,
    source: "defaults",
  };
}

function formatModelForAdapter(policy, adapterType, model) {
  if (!model) return null;
  const fmt = (policy.adapterModelFormat || {})[adapterType] || {};
  if (fmt.transform === "junie-custom") {
    // paperclip/ceo -> custom:omniroute-paperclip-ceo
    // auto/pro-coding -> custom:omniroute-pro-coding
    let short = model;
    if (short.startsWith("auto/")) short = short.slice("auto/".length);
    short = short.replace(/\//g, "-");
    return `custom:omniroute-${short}`;
  }
  if (fmt.prefix) {
    if (model.startsWith(fmt.prefix)) return model;
    return `${fmt.prefix}${model}`;
  }
  return model;
}

function junieProfileName(model) {
  // auto/pro-coding -> pro-coding
  return model.startsWith("auto/") ? model.slice("auto/".length).replace(/\//g, "-") : model.replace(/\//g, "-");
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const policy = loadPolicy();
  const allowed = new Set(policy.allowedModels || []);

  const pg = resolvePg();
  const client = new pg.Client({
    host: process.env.PC_PG_HOST || "127.0.0.1",
    port: Number(process.env.PC_PG_PORT || 54329),
    user: process.env.PC_PG_USER || "paperclip",
    password: process.env.PC_PG_PASSWORD || "paperclip",
    database: process.env.PC_PG_DATABASE || "paperclip",
  });

  await client.connect();
  const { rows: agents } = await client.query(
    `SELECT id, name, role, title, status, adapter_type, adapter_config, company_id
     FROM agents
     ORDER BY name`
  );

  let updated = 0,
    unchanged = 0,
    skipped = 0,
    errors = 0;
  const report = [];

  for (const agent of agents) {
    let target = resolveTarget(policy, agent);
    const adapterOverride = (policy.adapterOverrides || {})[agent.adapter_type];
    if (adapterOverride) {
      if (adapterOverride.skip) {
        target = { skip: true, reason: adapterOverride.note || `adapter override ${agent.adapter_type}` };
      } else {
        let model = adapterOverride.model;
        if (!model && adapterOverride.modelByRole) {
          model =
            adapterOverride.modelByRole[agent.role] ||
            adapterOverride.modelByRole.default ||
            null;
        }
        if (model) {
          target = {
            model,
            maxTurnsPerRun:
              adapterOverride.maxTurnsPerRun ??
              target.maxTurnsPerRun ??
              policy.defaults.maxTurnsPerRun,
            source: `adapterOverride:${agent.adapter_type}`,
          };
        }
      }
    }
    if (target.skip) {
      skipped++;
      report.push({
        id: agent.id,
        name: agent.name,
        action: "skip",
        reason: target.reason,
      });
      continue;
    }

    const fromAdapterOverride = String(target.source || "").startsWith("adapterOverride:");
    if (!fromAdapterOverride && !allowed.has(target.model) && !String(target.model).startsWith("custom:")) {
      const base = target.model;
      if (!allowed.has(base)) {
        errors++;
        report.push({
          id: agent.id,
          name: agent.name,
          action: "error",
          reason: `model not allowed: ${target.model}`,
        });
        continue;
      }
    }

    const formatted = formatModelForAdapter(
      policy,
      agent.adapter_type,
      target.model
    );
    const cfg =
      agent.adapter_config && typeof agent.adapter_config === "object"
        ? { ...agent.adapter_config }
        : {};

    const prevModel = cfg.model ?? null;
    const prevTurns = cfg.maxTurnsPerRun ?? null;
    const nextTurns = target.maxTurnsPerRun;

    if (prevModel === formatted && Number(prevTurns) === Number(nextTurns)) {
      unchanged++;
      report.push({
        id: agent.id,
        name: agent.name,
        role: agent.role,
        adapter: agent.adapter_type,
        action: "unchanged",
        model: formatted,
        maxTurnsPerRun: nextTurns,
        source: target.source,
      });
      continue;
    }

    cfg.model = formatted;
    cfg.maxTurnsPerRun = nextTurns;

    if (!dryRun) {
      await client.query(
        `UPDATE agents
         SET adapter_config = $1::jsonb,
             updated_at = NOW()
         WHERE id = $2`,
        [JSON.stringify(cfg), agent.id]
      );
    }

    updated++;
    report.push({
      id: agent.id,
      name: agent.name,
      role: agent.role,
      adapter: agent.adapter_type,
      action: dryRun ? "would-update" : "updated",
      from: prevModel,
      to: formatted,
      maxTurnsPerRun: nextTurns,
      prevTurns,
      source: target.source,
    });
  }

  await client.end();

  const summary = {
    dryRun,
    policyVersion: policy.version,
    total: agents.length,
    updated,
    unchanged,
    skipped,
    errors,
  };
  console.log(JSON.stringify({ summary, report }, null, 2));
  if (errors > 0) process.exitCode = 2;
}

main().catch((err) => {
  console.error("[agent-model-policy] FATAL", err);
  process.exit(1);
});
