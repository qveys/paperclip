# qveys-agent-router

Dynamic Paperclip runtime router.

Endpoints:

- `GET /healthz`
- `POST /route/preview` returns the routing decision only.
- `POST /route` decides and executes via the selected CLI runtime.
- `POST /route/stream` streams NDJSON events so Paperclip can display the live
  runtime transcript through the adapter.

Paperclip connection:

1. Rebuild/recreate the Paperclip image so the `qveys_agent_router` adapter is registered.
2. Configure an agent with adapter type `qveys_agent_router`.
3. Optional adapter config: `routerUrl` defaults to `http://127.0.0.1:3188`.
4. `showDecisionLog` defaults to `true` and writes one concise routing line into
   the Paperclip run log.
5. `streamLogs` defaults to `true` and relays stdout/stderr from the selected
   runtime into the Paperclip run log.

Display notes:

- The adapter ships a structured `./ui-parser` (Claude stream-json + Codex JSONL)
  so Paperclip UI maps lines to assistant/tool_call/tool_result/thinking/result;
  `thinking_tokens` noise is filtered. Without `./ui-parser` the UI gets 404.
- Claude/Codex runtimes use structured CLI output (`--output-format stream-json`
  / `codex exec --json`) so the run transcript is complete.
- The router process also mirrors child CLI stdout/stderr onto its own
  stdout/stderr (see `/tmp/qveys-agent-router.log` inside the container).


Routing rules:

- Edit `/opt/paperclip/qveys-agent-router/config.yaml` in the image source, or set `QVEYS_AGENT_ROUTER_CONFIG`.
- `omniroute.baseUrl` is the API prefix, for example `https://omniroute.quentinveys.be/v1`; concrete paths live under `omniroute.endpoints`.
- Profiles map the six logical OmniRoute profiles to real OmniRoute model ids.
- Category rules choose runtime/profile/fallback.
- Runtime keys currently cover Paperclip's local adapters/runtimes: `hermes`,
  `junie`, `antigravity`, `cursor`, `grok`, `ollama`, `claude`, `codex`,
  `gemini`. Unavailable commands are skipped and the next fallback is tried.

Limits:

- Classification is rule-based by default; `classifier.llmFallback` is reserved but disabled.
- CLI command syntaxes are config-driven because Hermes/Claude/Codex/Gemini flags drift.
- Cost is logged as `null` unless a runtime reports it.
