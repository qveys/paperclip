// src/worker.ts
import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";

// src/client.ts
var HindsightClient = class {
  baseUrl;
  token;
  constructor(baseUrl, token) {
    const url = baseUrl.trim();
    if (!url) throw new Error("hindsightApiUrl is required");
    this.baseUrl = url.replace(/\/$/, "");
    this.token = token;
  }
  headers() {
    const h = { "Content-Type": "application/json" };
    if (this.token) h["Authorization"] = `Bearer ${this.token}`;
    return h;
  }
  async request(method, path, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15e3);
    try {
      const resp = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: this.headers(),
        body: body !== void 0 ? JSON.stringify(body) : void 0,
        signal: controller.signal
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(`HTTP ${resp.status} from ${path}: ${text}`);
      }
      return await resp.json();
    } finally {
      clearTimeout(timer);
    }
  }
  async recall(bankId, query, budget = "mid") {
    const path = `/v1/default/banks/${encodeURIComponent(bankId)}/memories/recall`;
    return this.request("POST", path, {
      query,
      budget,
      max_tokens: 1024
    });
  }
  async retain(bankId, content, documentId, metadata) {
    const path = `/v1/default/banks/${encodeURIComponent(bankId)}/memories`;
    const item = {
      content,
      context: "paperclip"
    };
    if (documentId) item["document_id"] = documentId;
    if (metadata) item["metadata"] = metadata;
    await this.request("POST", path, { items: [item], async: true });
  }
  async health() {
    try {
      const resp = await fetch(`${this.baseUrl}/health`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(5e3)
      });
      return resp.ok;
    } catch {
      return false;
    }
  }
};
function formatMemories(memories) {
  if (memories.length === 0) return "";
  return memories.map((m) => `- ${m.text}`).join("\n");
}

// src/bank.ts
function deriveBankId(context, config) {
  const staticId = config.bankId?.trim();
  if (staticId && config.dynamicBankId !== true) {
    return staticId;
  }
  const granularity = config.bankGranularity ?? ["company", "agent"];
  const parts = ["paperclip"];
  for (const field of granularity) {
    if (field === "company") parts.push(context.companyId);
    if (field === "agent") parts.push(context.agentId);
    if (field === "user" && context.userId) {
      parts.push("user");
      parts.push(context.userId);
    }
  }
  return parts.join("::");
}
function extractUserFromIssue(issue) {
  if (issue.creatorEmail) return issue.creatorEmail;
  if (!issue.originId) return void 0;
  const parts = issue.originId.split("::");
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i].includes("@")) return parts[i];
  }
  return void 0;
}

// src/worker.ts
async function getConfig(ctx, companyId) {
  return await ctx.config.get(companyId);
}
async function resolveApiKey(ctx, config, companyId) {
  if (!config.hindsightApiKeyRef) return void 0;
  const resolved = await ctx.secrets.resolve(config.hindsightApiKeyRef, {
    companyId,
    configPath: "hindsightApiKeyRef"
  });
  return resolved ?? void 0;
}
function isAgentEnabled(config, agentId) {
  const allowlist = config.enabledAgentIds;
  if (!allowlist || allowlist.length === 0) return true;
  return !!agentId && allowlist.includes(agentId);
}
var plugin = definePlugin({
  multiCompanyConfig: true,
  async setup(ctx) {
    ctx.logger.info("Hindsight memory plugin starting");
    ctx.events.on("agent.run.started", async (event) => {
      const payload = event.payload;
      const companyId = event.companyId;
      const config = await getConfig(ctx, companyId);
      const { agentId, runId, issueId } = payload;
      if (!isAgentEnabled(config, agentId)) return;
      if (!issueId || !companyId) return;
      let issue;
      try {
        issue = await ctx.issues.get(issueId, companyId);
      } catch (err) {
        ctx.logger.warn("Failed to fetch issue for recall", {
          runId,
          issueId,
          error: String(err)
        });
        return;
      }
      if (!issue) return;
      const query = [issue.title, issue.description].filter(Boolean).join("\n");
      if (!query.trim()) return;
      const userId = config.bankGranularity?.includes("user") ? extractUserFromIssue(issue) : void 0;
      if (userId) {
        await ctx.state.set({ scopeKind: "run", scopeId: runId, stateKey: "user-id" }, userId);
      }
      try {
        const apiKey = await resolveApiKey(ctx, config, companyId);
        const client = new HindsightClient(config.hindsightApiUrl, apiKey);
        const bankId = deriveBankId({ companyId, agentId, userId }, config);
        const response = await client.recall(bankId, query, config.recallBudget ?? "mid");
        const memories = formatMemories(response.results);
        if (memories) {
          await ctx.state.set(
            { scopeKind: "run", scopeId: runId, stateKey: "recalled-memories" },
            memories
          );
          ctx.logger.info("Recalled memories for run", {
            runId,
            bankId,
            count: response.results.length
          });
        }
      } catch (err) {
        ctx.logger.warn("Failed to recall memories on run start", {
          runId,
          error: String(err)
        });
      }
    });
    ctx.events.on("issue.comment.created", async (event) => {
      const companyId = event.companyId;
      const config = await getConfig(ctx, companyId);
      if (config.autoRetain === false) return;
      const issueId = event.entityId;
      const payload = event.payload ?? {};
      const commentId = payload.commentId;
      const payloadAgentId = payload.agentId ?? null;
      if (!issueId || !companyId || !commentId) return;
      let body = "";
      try {
        const comments = await ctx.issues.listComments(issueId, companyId);
        const match = comments.find((c) => c.id === commentId);
        if (match && typeof match.body === "string") body = match.body;
      } catch (err) {
        if (typeof payload.bodySnippet === "string") {
          body = payload.bodySnippet;
        } else {
          ctx.logger.warn("Failed to fetch comment body", {
            commentId,
            error: String(err)
          });
          return;
        }
      }
      if (!body.trim()) return;
      let bankAgentId = payloadAgentId;
      let userId;
      let issueForAttribution;
      if (!bankAgentId || config.bankGranularity?.includes("user")) {
        try {
          issueForAttribution = await ctx.issues.get(issueId, companyId);
          if (!bankAgentId) {
            bankAgentId = issueForAttribution?.assigneeAgentId ?? null;
          }
          if (config.bankGranularity?.includes("user") && issueForAttribution) {
            userId = extractUserFromIssue(issueForAttribution);
          }
        } catch {
        }
      }
      if (!bankAgentId) {
        ctx.logger.info("Skipping retain \u2014 no agent attribution available", {
          commentId,
          issueId
        });
        return;
      }
      if (!isAgentEnabled(config, bankAgentId)) {
        ctx.logger.debug("Skipping retain \u2014 agent not in enabled list", {
          commentId,
          agentId: bankAgentId
        });
        return;
      }
      try {
        const apiKey = await resolveApiKey(ctx, config, companyId);
        const client = new HindsightClient(config.hindsightApiUrl, apiKey);
        const bankId = deriveBankId({ companyId, agentId: bankAgentId, userId }, config);
        await client.retain(bankId, body, commentId, {
          agentId: bankAgentId,
          companyId,
          issueId,
          commentId
        });
        ctx.logger.info("Retained comment to memory", { commentId, bankId });
      } catch (err) {
        ctx.logger.warn("Failed to retain comment", {
          commentId,
          error: String(err)
        });
      }
    });
    ctx.events.on("agent.run.finished", async (event) => {
      const payload = event.payload;
      const config = await getConfig(ctx, event.companyId);
      if (!isAgentEnabled(config, payload?.agentId)) return;
      ctx.logger.debug(
        "agent.run.finished received (no-op; retention handled by issue.comment.created)",
        { runId: payload?.runId }
      );
    });
    ctx.tools.register(
      "hindsight_recall",
      {
        displayName: "Recall from Memory",
        description: "Search Hindsight long-term memory for context relevant to a query.",
        parametersSchema: {
          type: "object",
          required: ["query"],
          properties: {
            query: { type: "string", description: "What to search for" }
          }
        }
      },
      async (params, runCtx) => {
        const { query } = params;
        const config = await getConfig(ctx, runCtx.companyId);
        let userId;
        if (config.bankGranularity?.includes("user")) {
          const cachedUserId = await ctx.state.get({
            scopeKind: "run",
            scopeId: runCtx.runId,
            stateKey: "user-id"
          });
          if (cachedUserId && typeof cachedUserId === "string") userId = cachedUserId;
        }
        const bankId = deriveBankId(
          { companyId: runCtx.companyId, agentId: runCtx.agentId, userId },
          config
        );
        const cached = await ctx.state.get({
          scopeKind: "run",
          scopeId: runCtx.runId,
          stateKey: "recalled-memories"
        });
        if (cached && typeof cached === "string") {
          return { content: cached };
        }
        try {
          const apiKey = await resolveApiKey(ctx, config, runCtx.companyId);
          const client = new HindsightClient(config.hindsightApiUrl, apiKey);
          const response = await client.recall(bankId, query, config.recallBudget ?? "mid");
          const memories = formatMemories(response.results);
          return { content: memories || "No relevant memories found." };
        } catch (err) {
          return { content: `Memory recall failed: ${String(err)}` };
        }
      }
    );
    ctx.tools.register(
      "hindsight_retain",
      {
        displayName: "Save to Memory",
        description: "Store important facts, decisions, or outcomes in Hindsight long-term memory for future runs.",
        parametersSchema: {
          type: "object",
          required: ["content"],
          properties: {
            content: {
              type: "string",
              description: "The content to store in memory"
            }
          }
        }
      },
      async (params, runCtx) => {
        const { content } = params;
        const config = await getConfig(ctx, runCtx.companyId);
        let userId;
        if (config.bankGranularity?.includes("user")) {
          const cached = await ctx.state.get({
            scopeKind: "run",
            scopeId: runCtx.runId,
            stateKey: "user-id"
          });
          if (cached && typeof cached === "string") userId = cached;
        }
        const bankId = deriveBankId(
          { companyId: runCtx.companyId, agentId: runCtx.agentId, userId },
          config
        );
        try {
          const apiKey = await resolveApiKey(ctx, config, runCtx.companyId);
          const client = new HindsightClient(config.hindsightApiUrl, apiKey);
          await client.retain(bankId, content, void 0, {
            agentId: runCtx.agentId,
            companyId: runCtx.companyId,
            runId: runCtx.runId
          });
          return { content: "Memory saved." };
        } catch (err) {
          return { content: `Failed to save memory: ${String(err)}` };
        }
      }
    );
    ctx.logger.info("Hindsight memory plugin ready");
  },
  async onHealth() {
    return { status: "ok" };
  },
  async onValidateConfig(config) {
    const c = config;
    if (!c.hindsightApiUrl?.trim()) {
      return { ok: false, errors: ["hindsightApiUrl is required"] };
    }
    try {
      const client = new HindsightClient(c.hindsightApiUrl);
      const healthy = await client.health();
      if (!healthy) {
        return {
          ok: false,
          errors: [`Cannot reach Hindsight at ${c.hindsightApiUrl}`]
        };
      }
    } catch (err) {
      return { ok: false, errors: [`Connection failed: ${String(err)}`] };
    }
    return { ok: true };
  }
});
var worker_default = plugin;
runWorker(plugin, import.meta.url);
export {
  worker_default as default
};
