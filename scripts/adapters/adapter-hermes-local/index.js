import { readFileSync } from "fs";
import { join } from "path";

export { testEnvironment, sessionCodec } from "hermes-paperclip-adapter/server";
import { execute as _hermesExecute } from "hermes-paperclip-adapter/server";
export { models, agentConfigurationDoc } from "hermes-paperclip-adapter";

export const TYPE = "hermes_local";
const DEFAULT_COMMAND = "hermes-remote";
const PAPERCLIP_HOME = process.env.PAPERCLIP_HOME || "/paperclip";

const PROMPT_TEMPLATE = `You are "{{agentName}}", an AI agent employee in a Paperclip-managed company.

Your Paperclip identity:
  Agent ID   : {{agentId}}
    Company ID : {{companyId}}
      API Base   : {{paperclipApiUrl}}

      ## Your Role

      {{agentInstructions}}

      ---

      IMPORTANT: Use the \`paperclip_*\` MCP tools for ALL Paperclip operations.
      Do NOT use curl for Paperclip API calls — the MCP tools handle authentication
      automatically and are always available.

      Key tools: paperclip_list_issues, paperclip_get_issue, paperclip_checkout_issue,
      paperclip_update_issue, paperclip_add_comment, paperclip_release_issue,
      paperclip_list_agents, paperclip_list_labels, paperclip_get_heartbeat_context.

      {{#taskId}}
      ## Assigned Task

      Issue ID : {{taskId}}
      Title    : {{taskTitle}}

      {{taskBody}}

      ## Workflow

      1. Work on the task using your tools.
      2. When done: paperclip_update_issue(issueId="{{taskId}}", status="done", comment="<summary>")
      3. If this issue has a parent, notify the parent owner with paperclip_add_comment.
      {{/taskId}}

      {{#commentId}}
      ## Comment on {{taskId}}

      Use paperclip_get_heartbeat_context to read the full context, address the comment,
      and reply via paperclip_add_comment if needed.
      {{/commentId}}

      {{#noTask}}
      ## Heartbeat Wake — Check for Work

      1. paperclip_list_issues() → open issues assigned to you (todo / in_progress / blocked).
      2. If found, pick the highest-priority one and work on it (checkout first).
      3. If none assigned, check unassigned backlog issues.
      4. If truly nothing to do, report briefly what you checked.
      {{/noTask}}`;

function loadAgentInstructions(agent) {
  if (!agent || !agent.id || !agent.companyId) return "";
  try {
    const filePath = join(
      PAPERCLIP_HOME,
      "instances",
      "default",
      "companies",
      agent.companyId,
      "agents",
      agent.id,
      "instructions",
      "AGENTS.md",
    );
    return readFileSync(filePath, "utf8").trim();
  } catch (e) {
    return "";
  }
}

export async function execute(ctx) {
  const baseConfig = ctx && ctx.config ? ctx.config : {};
  const agentInstructions = loadAgentInstructions(ctx.agent);

  const promptTemplate = PROMPT_TEMPLATE.replace(
    "{{agentInstructions}}",
    agentInstructions || "(No role instructions defined for this agent.)",
  );

  const existingAdapterConfig =
    ctx.agent && ctx.agent.adapterConfig ? ctx.agent.adapterConfig : {};

  // _hermesExecute reads ctx.config (not ctx.agent.adapterConfig) to resolve hermesCommand.
  // Merge hermesCommand into config so the default "hermes-remote" is honoured.
  const config = {
    hermesCommand: DEFAULT_COMMAND,
    ...baseConfig,
    promptTemplate,
  };

  return _hermesExecute({
    ...ctx,
    agent: {
      ...ctx.agent,
      adapterConfig: {
        hermesCommand: DEFAULT_COMMAND,
        ...existingAdapterConfig,
        promptTemplate,
      },
    },
    config,
  });
}

export function getConfigSchema() {
  return {
    fields: [
      {
        key: "hermesCommand",
        label: "Hermes command",
        type: "text",
        default: DEFAULT_COMMAND,
        hint: "Defaults to 'hermes-remote' (docker exec shim). Set to 'hermes' for direct local execution.",
      },
    ],
  };
}

export function createServerAdapter() {
  return {
    type: TYPE,
    label: "Hermes Agent (remote)",
    execute,
    getConfigSchema,
  };
}
