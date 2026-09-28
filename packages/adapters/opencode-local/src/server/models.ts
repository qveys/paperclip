import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import net from "node:net";
import os from "node:os";
import type { AdapterModel } from "@paperclipai/adapter-utils";
import {
  asString,
  ensurePathInEnv,
} from "@paperclipai/adapter-utils/server-utils";
import { isValidOpenCodeModelId } from "../index.js";

const MODELS_CACHE_TTL_MS = 60_000;
// OpenCode V2's `run`/`models` share a background service that populates its
// model catalog asynchronously (~1s after boot). A `--standalone` CLI
// invocation (`opencode models --standalone`, `opencode api model.list
// --standalone`) tears that service down again before the catalog is ready,
// so it always returns empty. The only reliable way to read the catalog is
// to start our own `opencode serve` instance and poll its HTTP API.
const MODELS_SERVE_PASSWORD_TIMEOUT_MS = 5_000;
const MODELS_SERVE_POLL_TIMEOUT_MS = 5_000;
const MODELS_SERVE_POLL_INTERVAL_MS = 250;
// A transient `opencode serve` startup failure (port race, slow boot under
// load) is worth a couple of retries with backoff before surfacing a hard
// failure (carried over from the V1 `opencode models` retry behaviour,
// SAG-6326/SAG-6336).
const MODELS_DISCOVERY_RETRY_DELAYS_MS = [2_000, 4_000];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveOpenCodeCommand(input: unknown): string {
  const envOverride =
    typeof process.env.PAPERCLIP_OPENCODE_COMMAND === "string" &&
    process.env.PAPERCLIP_OPENCODE_COMMAND.trim().length > 0
      ? process.env.PAPERCLIP_OPENCODE_COMMAND.trim()
      : "opencode";
  return asString(input, envOverride);
}

const discoveryCache = new Map<
  string,
  { expiresAt: number; models: AdapterModel[] }
>();
const VOLATILE_ENV_KEY_PREFIXES = ["PAPERCLIP_", "npm_", "NPM_"] as const;
const VOLATILE_ENV_KEY_EXACT = new Set([
  "PWD",
  "OLDPWD",
  "SHLVL",
  "_",
  "TERM_SESSION_ID",
  "HOME",
]);

export function requireOpenCodeModelId(input: unknown): string {
  const model = asString(input, "").trim();
  if (!isValidOpenCodeModelId(model)) {
    throw new Error(
      "OpenCode requires `adapterConfig.model` in provider/model format.",
    );
  }
  return model;
}

function dedupeModels(models: AdapterModel[]): AdapterModel[] {
  const seen = new Set<string>();
  const deduped: AdapterModel[] = [];
  for (const model of models) {
    const id = model.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    deduped.push({ id, label: model.label.trim() || id });
  }
  return deduped;
}

function sortModels(models: AdapterModel[]): AdapterModel[] {
  return [...models].sort((a, b) =>
    a.id.localeCompare(b.id, "en", { numeric: true, sensitivity: "base" }),
  );
}

// Still used by execute.ts's separate remote-probe path (plain `opencode
// models`, not `--standalone`), which parses the CLI's line-oriented stdout.
export function parseOpenCodeModelsOutput(stdout: string): AdapterModel[] {
  const parsed: AdapterModel[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const firstToken = line.split(/\s+/)[0]?.trim() ?? "";
    if (!firstToken.includes("/")) continue;
    const provider = firstToken.slice(0, firstToken.indexOf("/")).trim();
    const model = firstToken.slice(firstToken.indexOf("/") + 1).trim();
    if (!provider || !model) continue;
    parsed.push({ id: `${provider}/${model}`, label: `${provider}/${model}` });
  }
  return dedupeModels(parsed);
}

function normalizeEnv(input: unknown): Record<string, string> {
  const envInput =
    typeof input === "object" && input !== null && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(envInput)) {
    if (typeof value === "string") env[key] = value;
  }
  return env;
}

function isVolatileEnvKey(key: string): boolean {
  if (VOLATILE_ENV_KEY_EXACT.has(key)) return true;
  return VOLATILE_ENV_KEY_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function hashValue(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function discoveryCacheKey(
  command: string,
  cwd: string,
  env: Record<string, string>,
) {
  const envKey = Object.entries(env)
    .filter(([key]) => !isVolatileEnvKey(key))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${hashValue(value)}`)
    .join("\n");
  return `${command}\n${cwd}\n${envKey}`;
}

function pruneExpiredDiscoveryCache(now: number) {
  for (const [key, value] of discoveryCache.entries()) {
    if (value.expiresAt <= now) discoveryCache.delete(key);
  }
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : null;
      server.close((err) => {
        if (err) reject(err);
        else if (port) resolve(port);
        else reject(new Error("Could not allocate a free port for `opencode serve`."));
      });
    });
  });
}

const SERVE_PASSWORD_RE = /server password\s+(\S+)/i;

// `opencode serve` prints its Basic-auth password to stdout once it's ready
// to accept requests. Wait for that line, or fail fast on exit/error.
function waitForServePassword(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout.off("data", onData);
      child.off("exit", onExit);
      child.off("error", onError);
    };
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const match = buffer.match(SERVE_PASSWORD_RE);
      if (match) {
        cleanup();
        resolve(match[1]!);
      }
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`\`opencode serve\` exited (code ${code}) before printing its password.`));
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for `opencode serve` to print its password."));
    }, timeoutMs);
    child.stdout.on("data", onData);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

function parseOpenCodeModelEntry(entry: unknown): AdapterModel | null {
  if (typeof entry !== "object" || entry === null) return null;
  const rec = entry as Record<string, unknown>;
  const providerID = asString(rec.providerID, "").trim();
  const modelID = asString(rec.modelID, "").trim();
  if (!providerID || !modelID) return null;
  const id = `${providerID}/${modelID}`;
  const name = asString(rec.name, "").trim();
  return { id, label: name || id };
}

// Polls GET /api/model until the catalog is non-empty or the deadline
// passes. An empty catalog at the deadline is not an error -- same outcome
// as V1's empty `opencode models` result.
async function pollModelCatalog(
  port: number,
  password: string,
  timeoutMs: number,
  intervalMs: number,
): Promise<AdapterModel[]> {
  const auth = Buffer.from(`opencode:${password}`).toString("base64");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/model`, {
        headers: { Authorization: `Basic ${auth}` },
      });
      if (response.ok) {
        const body = (await response.json()) as { data?: unknown[] };
        if (Array.isArray(body.data) && body.data.length > 0) {
          const models = body.data
            .map(parseOpenCodeModelEntry)
            .filter((model): model is AdapterModel => model !== null);
          if (models.length > 0) return dedupeModels(models);
        }
      }
    } catch {
      // Server may still be booting; keep polling until the deadline.
    }
    await sleep(intervalMs);
  }
  return [];
}

async function discoverOpenCodeModelsViaServe(
  command: string,
  cwd: string,
  env: Record<string, string>,
): Promise<AdapterModel[]> {
  const port = await getFreePort();
  const child = spawn(command, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd,
    env,
  });
  // waitForServePassword already listens for "error"; this guards against a
  // crash from an error emitted later, during polling.
  child.on("error", () => {});
  try {
    const password = await waitForServePassword(child, MODELS_SERVE_PASSWORD_TIMEOUT_MS);
    return await pollModelCatalog(
      port,
      password,
      MODELS_SERVE_POLL_TIMEOUT_MS,
      MODELS_SERVE_POLL_INTERVAL_MS,
    );
  } finally {
    child.kill();
  }
}

export async function discoverOpenCodeModels(
  input: {
    command?: unknown;
    cwd?: unknown;
    env?: unknown;
    // V2 has no discrete "refresh the catalog" call: every discovery here
    // starts its own fresh `opencode serve` instance and reads its live
    // catalog, so the separate --refresh step V1 needed is now a no-op.
    // Kept on the signature for call-site compatibility (see
    // refreshOpenCodeModelsCached, which still does two discovery calls).
    refresh?: boolean;
  } = {},
): Promise<AdapterModel[]> {
  const command = resolveOpenCodeCommand(input.command);
  const cwd = asString(input.cwd, process.cwd());
  const env = normalizeEnv(input.env);
  // Ensure HOME points to the actual running user's home directory.
  // When the server is started via `runuser -u <user>`, HOME may still
  // reflect the parent process (e.g. /root), causing OpenCode to miss
  // provider auth credentials stored under the target user's home.
  let resolvedHome: string | undefined;
  try {
    resolvedHome = os.userInfo().homedir || undefined;
  } catch {
    // os.userInfo() throws a SystemError when the current UID has no
    // /etc/passwd entry (e.g. `docker run --user 1234` with a minimal
    // image). Fall back to process.env.HOME.
  }
  // Prevent OpenCode from writing an opencode.json into the working directory.
  const runtimeEnv = normalizeEnv(
    ensurePathInEnv({
      ...process.env,
      ...env,
      ...(resolvedHome ? { HOME: resolvedHome } : {}),
      OPENCODE_DISABLE_PROJECT_CONFIG: "true",
    }),
  );

  const maxAttempts = MODELS_DISCOVERY_RETRY_DELAYS_MS.length + 1;
  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return sortModels(await discoverOpenCodeModelsViaServe(command, cwd, runtimeEnv));
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }

    const delayMs = MODELS_DISCOVERY_RETRY_DELAYS_MS[attempt - 1];
    if (delayMs === undefined) break;
    await sleep(delayMs);
  }

  throw lastError ?? new Error("`opencode serve` failed.");
}

export async function discoverOpenCodeModelsCached(
  input: {
    command?: unknown;
    cwd?: unknown;
    env?: unknown;
  } = {},
): Promise<AdapterModel[]> {
  const command = resolveOpenCodeCommand(input.command);
  const cwd = asString(input.cwd, process.cwd());
  const env = normalizeEnv(input.env);
  const key = discoveryCacheKey(command, cwd, env);
  const now = Date.now();
  pruneExpiredDiscoveryCache(now);
  const cached = discoveryCache.get(key);
  if (cached && cached.expiresAt > now) return cached.models;

  const models = await discoverOpenCodeModels({ command, cwd, env });
  discoveryCache.set(key, { expiresAt: now + MODELS_CACHE_TTL_MS, models });
  return models;
}

async function refreshOpenCodeModelsCached(input: {
  command?: unknown;
  cwd?: unknown;
  env?: unknown;
}): Promise<AdapterModel[]> {
  const command = resolveOpenCodeCommand(input.command);
  const cwd = asString(input.cwd, process.cwd());
  const env = normalizeEnv(input.env);
  // `refresh: true` is a no-op in discoverOpenCodeModels now (see its jsdoc
  // comment) -- every call already reads a live catalog from a fresh `serve`
  // instance. This still does two calls rather than one to keep this
  // function's shape (and cache-population timing) close to the pre-V2
  // behaviour; the redundant first call costs one extra `opencode serve`
  // spawn on this rare fallback path.
  await discoverOpenCodeModels({
    command,
    cwd,
    env,
    refresh: true,
  });
  const models = await discoverOpenCodeModels({ command, cwd, env });
  if (models.length > 0) {
    discoveryCache.set(discoveryCacheKey(command, cwd, env), {
      expiresAt: Date.now() + MODELS_CACHE_TTL_MS,
      models,
    });
  }
  return models;
}

export function isTruthyEnvFlag(value: string | undefined): boolean {
  if (value === undefined) return false;
  const v = value.trim().toLowerCase();
  return v === "true" || v === "1" || v === "yes";
}

export async function ensureOpenCodeModelConfiguredAndAvailable(input: {
  model?: unknown;
  command?: unknown;
  cwd?: unknown;
  env?: unknown;
}): Promise<AdapterModel[]> {
  const model = requireOpenCodeModelId(input.model);

  // When the caller opts into OPENCODE_ALLOW_ALL_MODELS, OpenCode accepts any
  // provider/model at run time (e.g. gateway-routed models that never appear in
  // `opencode models` output). Honour that by skipping the availability probe;
  // we still enforce the provider/model format above and do not second-guess
  // the configured model. Prefer the explicit run env, then the process env.
  const env = normalizeEnv(input.env);
  if (
    isTruthyEnvFlag(
      env.OPENCODE_ALLOW_ALL_MODELS ?? process.env.OPENCODE_ALLOW_ALL_MODELS,
    )
  ) {
    return [{ id: model, label: model }];
  }

  let models: AdapterModel[];
  try {
    models = await discoverOpenCodeModelsCached({
      command: input.command,
      cwd: input.cwd,
      env: input.env,
    });
  } catch (err) {
    // The availability probe is a best-effort pre-flight guard, not a gate. If
    // discovery itself cannot run — a transient CLI error, a timeout, a
    // provider hiccup — do NOT abort the run. The real invocation is
    // authoritative, so a probe that can't execute must never be fatal.
    // (Previously this threw and crashed runs mid-flight, discarding the agent's
    // completed work and its terminal disposition, which then reopened the issue.)
    console.warn(
      `[opencode-local] Model availability probe could not run for "${model}" (${
        err instanceof Error ? err.message : String(err)
      }); proceeding with the configured model.`,
    );
    return [{ id: model, label: model }];
  }

  if (models.length === 0) {
    // The probe ran but returned nothing (e.g. a transient provider-auth blip).
    // Same reasoning as above: warn, don't block the run.
    console.warn(
      `[opencode-local] \`opencode models\` returned no models; proceeding with the configured model "${model}".`,
    );
    return [{ id: model, label: model }];
  }

  if (!models.some((entry) => entry.id === model)) {
    // The discovery cache can go stale on a long-lived runner host even while
    // the configured provider serves the model. Refresh once before treating
    // a cached miss as authoritative; a successful refresh that still omits
    // the model retains the strict availability rejection below.
    try {
      const refreshedModels = await refreshOpenCodeModelsCached({
        command: input.command,
        cwd: input.cwd,
        env: input.env,
      });
      if (refreshedModels.some((entry) => entry.id === model)) {
        return refreshedModels;
      }
      if (refreshedModels.length > 0) models = refreshedModels;
    } catch (err) {
      console.warn(
        `[opencode-local] Model availability refresh failed for "${model}" (${
          err instanceof Error ? err.message : String(err)
        }); preserving the cached availability rejection.`,
      );
    }

    const sample = models
      .slice(0, 12)
      .map((entry) => entry.id)
      .join(", ");
    throw new Error(
      `Configured OpenCode model is unavailable: ${model}. Available models: ${sample}${models.length > 12 ? ", ..." : ""}`,
    );
  }

  return models;
}

export async function listOpenCodeModels(): Promise<AdapterModel[]> {
  try {
    return await discoverOpenCodeModelsCached();
  } catch {
    return [];
  }
}

export function resetOpenCodeModelsCacheForTests() {
  discoveryCache.clear();
}
