#!/usr/bin/env bash
#
# 37-company-wizard-secret-resolve.sh
#
# Patch @yesterday-ai/paperclip-plugin-company-wizard (≤0.1.16) pour résoudre
# les secret_ref (paperclipPassword ET anthropicApiKey) avant de les envoyer
# en clair à l'API d'auth / à l'API Anthropic.
#
# Bug upstream : le manifest déclare ces deux champs avec "format":"secret-ref"
# (le secret-picker s'affiche dans l'UI — la valeur peut être stockée via le
# secrets adapter local chiffré de Paperclip), mais le worker lit cfg.<champ>
# comme une chaîne brute sans jamais appeler ctx.secrets.resolve(). Résultat :
# l'objet {type:"secret_ref",...} sérialisé est envoyé tel quel → 401 (auth)
# ou clé Anthropic invalide (ai-chat).
#
# Fix, en trois passes indépendantes (markers séparés, donc idempotentes
# séparément — une réinstallation du plugin ou un ancien volume déjà patché
# en v1 ne casse pas les passes suivantes) :
#   1. injecte un helper __pcResolveSecret capturant ctx.secrets.resolve
#      pendant setup(), et remplace les 3 usages de paperclipPassword.
#   2. remplace l'usage de anthropicApiKey dans l'action "ai-chat" en
#      réutilisant le même helper (déjà injecté par la passe 1).
#   3. upgrade le helper v1 -> v2 : la config stocke les secret-refs comme
#      chaînes UUID nues (l'id de la ligne company_secrets — cf.
#      plugin-secrets-handler.js serveur), PAS comme objets
#      {type:"secret_ref"}. Le helper v1 laissait donc passer l'UUID tel
#      quel -> envoyé comme x-api-key -> 401 Anthropic. Le v2 résout toute
#      chaîne en forme d'UUID via ctx.secrets.resolve.
#   4. remplace le modèle Anthropic codé en dur claude-sonnet-4-20250514
#      (retiré -> 404 not_found_error) par claude-sonnet-5, avec
#      thinking désactivé explicitement : Sonnet 5 active le thinking
#      adaptatif quand le champ est omis, et le plugin lit
#      data.content[0].text — un bloc thinking en tête casserait le parsing.
#   5. remplace ctx.issues.create/update (bridge plugin) par le client REST
#      board dans start-provision. Double bug upstream : (a) le runtime SDK
#      bundlé n'écho jamais paperclipInvocationId, donc tout appel bridge
#      company-scopé est rejeté (INVOCATION_SCOPE_DENIED "missing, expired,
#      or unknown") dès qu'une invocation est active — config.get et
#      secrets.resolve passent car les appels SANS companyId sautent le
#      contrôle ; (b) même corrigé, l'invocation est scopée sur la company
#      d'où le wizard est lancé alors que l'issue bootstrap est créée dans
#      la NOUVELLE company -> mismatch. Le reste du provisioning
#      (createCompany, createAgent...) passe déjà par le client REST board
#      (client._fetch, cookie de session) qui n'est pas soumis au scope —
#      on aligne la création de l'issue bootstrap dessus, avec
#      status:"todo" directement dans le POST (accepté par
#      createIssueSchema) pour remplacer aussi le ctx.issues.update.
#   6. symlinks dans le check d'entrypoint du worker.
#   7. secrets résolus dans le scope de la company (le point 3 ne suffit
#      plus) : plugin-secrets-handler exige un objet {type:"secret_ref"} ET un
#      companyId, avec configPath pour trouver le binding. Le SDK bundlé ne
#      transmet que { secretRef } -> on lui fait passer les options, le helper
#      v3 envoie l'objet + companyId + configPath, et les actions lisent la
#      config et résolvent avec params.companyId (injecté par l'hôte depuis la
#      company sélectionnée dans l'UI). Sans invocationId, l'hôte admet l'appel
#      via les scopes proactifs = companies où le plugin est configuré.
#      validateConfig (bouton Test) ne reçoit AUCUNE company : un
#      paperclipPassword en secret y est signalé en warning, pas testé.
#   8. manifest : déclare la capacité "secrets.read-ref" (exigée par
#      secrets.resolve). Le loader resynchronise manifestJson en base au
#      démarrage quand le fichier diffère — pas d'étape d'approbation.
#   9. rétroporte l'écho de paperclipInvocationId du SDK courant
#      (worker-rpc-host.ts : AsyncLocalStorage). L'hôte rejette désormais
#      tout appel worker→hôte SANS id quand une invocation est active
#      (invalidInvocationScope) — y compris config.get sans companyId, que
#      le point 5 croyait exempté. Symptôme : « Failed to load templates:
#      Request failed: 502 » (getData templates -> config.get refusé).
#
# Idempotent (marker par passe). Fail-SOFT : n'arrête jamais le démarrage.
# Survit aux rebuild image / recreate / wipe volume / reinstall plugin.
set -uo pipefail

source "$(dirname "$(readlink -f "$0")")/../lib/common.sh"
PC_LOG_PREFIX="37-company-wizard-secret-resolve"
PC_PATCH_LIB="$(dirname "$(readlink -f "$0")")/../lib/patch.js"

WORKER="/paperclip/.paperclip/plugins/node_modules/@yesterday-ai/paperclip-plugin-company-wizard/dist/worker.js"

if [ ! -f "$WORKER" ]; then
  pc_warn "Company Wizard plugin introuvable — skipping (pas encore installé ?)"
  exit 0
fi

WORKER_FILE="$WORKER" PC_PATCH_LIB="$PC_PATCH_LIB" node <<'NODE' || { pc_warn "patch step failed — continuing startup"; exit 0; }
const { applyPatch } = require(process.env.PC_PATCH_LIB);
const file = process.env.WORKER_FILE;
const MARKER = 'PC_COMPANY_WIZARD_SECRET_RESOLVE_v1';

applyPatch({
  file,
  marker: MARKER,
  mode: 'soft',
  edits: [
    // 1. Injecte le helper module-level avant definePlugin
    {
      label: 'inject-helper',
      anchor: 'var plugin = definePlugin({',
      replacement:
        '/* ' + MARKER + ' */\n' +
        'let __pcResolveSecret = async (v) => {\n' +
        '  if (!v) return "";\n' +
        '  if (typeof v === "object" && v.type === "secret_ref") return "";\n' +
        '  return typeof v === "string" ? v : "";\n' +
        '};\n' +
        'var plugin = definePlugin({',
    },
    // 2. Capture ctx.secrets.resolve au début de setup()
    {
      label: 'capture-ctx',
      anchor: '  async setup(ctx) {\n    ctx.data.register("templates"',
      replacement:
        '  async setup(ctx) {\n' +
        '    __pcResolveSecret = async (v) => {\n' +
        '      if (!v) return "";\n' +
        '      if (typeof v === "object" && v.type === "secret_ref") return await ctx.secrets.resolve(v);\n' +
        '      return typeof v === "string" ? v : "";\n' +
        '    }; // ' + MARKER + '\n' +
        '    ctx.data.register("templates"',
    },
    // 3. Fix action check-auth
    {
      label: 'fix-check-auth',
      anchor:
        '          email: cfg.paperclipEmail || "",\n' +
        '          password: cfg.paperclipPassword || ""\n' +
        '        });\n' +
        '        await client.connect();\n' +
        '        return { ok: true };\n' +
        '      } catch (err) {\n' +
        '        return { ok: false, error: err instanceof Error ? err.message : String(err) };\n' +
        '      }\n' +
        '    });\n' +
        '    ctx.actions.register("ai-chat"',
      replacement:
        '          email: cfg.paperclipEmail || "",\n' +
        '          password: await __pcResolveSecret(cfg.paperclipPassword) // ' + MARKER + '\n' +
        '        });\n' +
        '        await client.connect();\n' +
        '        return { ok: true };\n' +
        '      } catch (err) {\n' +
        '        return { ok: false, error: err instanceof Error ? err.message : String(err) };\n' +
        '      }\n' +
        '    });\n' +
        '    ctx.actions.register("ai-chat"',
    },
    // 4. Fix action start-provision
    {
      label: 'fix-start-provision',
      anchor: '        const paperclipPassword = cfg.paperclipPassword || "";',
      replacement: '        const paperclipPassword = await __pcResolveSecret(cfg.paperclipPassword); // ' + MARKER,
    },
    // 5. Fix onValidateConfig
    {
      label: 'fix-validate-config',
      anchor:
        '        email: config.paperclipEmail || "",\n' +
        '        password: config.paperclipPassword || ""\n' +
        '      });\n' +
        '      await client.connect();\n' +
        '      return { ok: true };\n' +
        '    } catch (err) {\n' +
        '      return {\n' +
        '        ok: false,\n' +
        '        errors: [err instanceof Error ? err.message : String(err)]\n' +
        '      };\n' +
        '    }\n' +
        '  }\n' +
        '});\n' +
        'var worker_default = plugin;',
      replacement:
        '        email: config.paperclipEmail || "",\n' +
        '        password: await __pcResolveSecret(config.paperclipPassword) // ' + MARKER + '\n' +
        '      });\n' +
        '      await client.connect();\n' +
        '      return { ok: true };\n' +
        '    } catch (err) {\n' +
        '      return {\n' +
        '        ok: false,\n' +
        '        errors: [err instanceof Error ? err.message : String(err)]\n' +
        '      };\n' +
        '    }\n' +
        '  }\n' +
        '});\n' +
        'var worker_default = plugin;',
    },
  ],
});
NODE

# Passe 2 : anthropicApiKey (action "ai-chat"), gate séparé — dépend du helper
# __pcResolveSecret injecté par la passe 1 ci-dessus.
if grep -q 'PC_COMPANY_WIZARD_SECRET_RESOLVE_v1' "$WORKER"; then
  WORKER_FILE="$WORKER" PC_PATCH_LIB="$PC_PATCH_LIB" node <<'NODE' || { pc_warn "anthropicApiKey patch step failed — continuing startup"; exit 0; }
const { applyPatch } = require(process.env.PC_PATCH_LIB);
const file = process.env.WORKER_FILE;
const MARKER = 'PC_COMPANY_WIZARD_ANTHROPIC_SECRET_RESOLVE_v1';

applyPatch({
  file,
  marker: MARKER,
  mode: 'soft',
  edits: [
    // Fix action ai-chat : résoudre le secret_ref avant de l'utiliser comme clé API
    {
      label: 'fix-ai-chat-apikey',
      anchor: '        const apiKey = cfg.anthropicApiKey || "";',
      replacement: '        const apiKey = await __pcResolveSecret(cfg.anthropicApiKey); // ' + MARKER,
    },
  ],
});
NODE
else
  pc_warn "__pcResolveSecret helper absent (passe 1 pas appliquée) — anthropicApiKey non patché"
fi

# Passe 3 : upgrade du helper v1 -> v2. Les valeurs de config secret-ref sont
# des chaînes UUID nues (id de company_secrets), pas des objets — le helper
# doit les résoudre au lieu de les laisser passer telles quelles.
WORKER_FILE="$WORKER" PC_PATCH_LIB="$PC_PATCH_LIB" node <<'NODE' || { pc_warn "uuid-string helper upgrade failed — continuing startup"; exit 0; }
const { applyPatch } = require(process.env.PC_PATCH_LIB);
const file = process.env.WORKER_FILE;
const V1 = 'PC_COMPANY_WIZARD_SECRET_RESOLVE_v1';
const MARKER = 'PC_COMPANY_WIZARD_SECRET_RESOLVE_UUID_v2';

applyPatch({
  file,
  marker: MARKER,
  mode: 'soft',
  edits: [
    {
      label: 'upgrade-helper-uuid-strings',
      anchor:
        '    __pcResolveSecret = async (v) => {\n' +
        '      if (!v) return "";\n' +
        '      if (typeof v === "object" && v.type === "secret_ref") return await ctx.secrets.resolve(v);\n' +
        '      return typeof v === "string" ? v : "";\n' +
        '    }; // ' + V1,
      replacement:
        '    __pcResolveSecret = async (v) => {\n' +
        '      if (!v) return "";\n' +
        '      const s = typeof v === "string" ? v.trim() : "";\n' +
        '      if (/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(s)) return await ctx.secrets.resolve(s);\n' +
        '      if (typeof v === "object" && v.type === "secret_ref") return await ctx.secrets.resolve(String(v.id ?? v.secretId ?? ""));\n' +
        '      return typeof v === "string" ? v : "";\n' +
        '    }; // ' + V1 + ' ' + MARKER,
    },
  ],
});
NODE

# Passe 4 : modèle Anthropic retiré -> claude-sonnet-5 (thinking désactivé
# pour préserver le parsing data.content[0].text du plugin).
WORKER_FILE="$WORKER" PC_PATCH_LIB="$PC_PATCH_LIB" node <<'NODE' || { pc_warn "model swap patch failed — continuing startup"; exit 0; }
const { applyPatch } = require(process.env.PC_PATCH_LIB);
const file = process.env.WORKER_FILE;
const MARKER = 'PC_COMPANY_WIZARD_MODEL_v1';

applyPatch({
  file,
  marker: MARKER,
  mode: 'soft',
  edits: [
    {
      label: 'swap-retired-model',
      anchor:
        '            model: "claude-sonnet-4-20250514",\n' +
        '            max_tokens: 8192,',
      replacement:
        '            model: "claude-sonnet-5", // ' + MARKER + ' (claude-sonnet-4-20250514 retiré)\n' +
        '            max_tokens: 8192,\n' +
        '            thinking: { type: "disabled" },',
    },
  ],
});
NODE

# Passe 5 : issue bootstrap via le client REST board au lieu du bridge plugin
# (INVOCATION_SCOPE_DENIED — voir l'en-tête, point 5).
WORKER_FILE="$WORKER" PC_PATCH_LIB="$PC_PATCH_LIB" node <<'NODE' || { pc_warn "rest-issue patch failed — continuing startup"; exit 0; }
const { applyPatch } = require(process.env.PC_PATCH_LIB);
const file = process.env.WORKER_FILE;
const MARKER = 'PC_COMPANY_WIZARD_REST_ISSUE_v1';

applyPatch({
  file,
  marker: MARKER,
  mode: 'soft',
  edits: [
    {
      label: 'bootstrap-issue-via-rest',
      anchor:
        '          const issue = await ctx.issues.create({\n' +
        '            companyId,\n' +
        '            title: `Bootstrap ${company.name || companyName}`,\n' +
        '            description: bootstrapDescription,\n' +
        '            assigneeAgentId: ceoAgentId\n' +
        '          });\n' +
        '          await ctx.issues.update(issue.id, { status: "todo" }, companyId);',
      replacement:
        '          // ' + MARKER + ': client REST board (comme createCompany/createAgent) —\n' +
        '          // le bridge plugin est rejeté (invocation scope) pour la nouvelle company.\n' +
        '          const issue = await client._fetch(`/api/companies/${companyId}/issues`, {\n' +
        '            method: "POST",\n' +
        '            body: JSON.stringify({\n' +
        '              title: `Bootstrap ${company.name || companyName}`,\n' +
        '              description: bootstrapDescription,\n' +
        '              status: "todo",\n' +
        '              assigneeAgentId: ceoAgentId || void 0\n' +
        '            })\n' +
        '          });',
    },
  ],
});
NODE

# Passe 6 : support symlinks dans runWorker entrypoint check
WORKER_FILE="$WORKER" PC_PATCH_LIB="$PC_PATCH_LIB" node <<'NODE' || { pc_warn "symlink entrypoint patch failed — continuing startup"; exit 0; }
const { applyPatch } = require(process.env.PC_PATCH_LIB);
const file = process.env.WORKER_FILE;
const MARKER = 'PC_COMPANY_WIZARD_SYMLINK_RESOLVE_v1';

applyPatch({
  file,
  marker: MARKER,
  mode: 'soft',
  edits: [
    {
      label: 'resolve-symlinks-in-entrypoint-check',
      anchor: '  if (thisFile === entryPath) {',
      replacement: '  if (thisFile === entryPath || (fs.existsSync(thisFile) && fs.existsSync(entryPath) && fs.realpathSync(thisFile) === fs.realpathSync(entryPath))) { // ' + MARKER,
    },
  ],
});
NODE

# Passe 7 : secrets résolus dans le scope de la company (voir l'en-tête, point 7).
WORKER_FILE="$WORKER" PC_PATCH_LIB="$PC_PATCH_LIB" node <<'NODE' || { pc_warn "company-scoped secret patch failed — continuing startup"; exit 0; }
const { applyPatch } = require(process.env.PC_PATCH_LIB);
const file = process.env.WORKER_FILE;
const MARKER = 'PC_COMPANY_WIZARD_SECRET_SCOPE_v3';
const UUID = '/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/';

applyPatch({
  file,
  marker: MARKER,
  mode: 'soft',
  edits: [
    {
      label: 'sdk-secrets-resolve-options',
      anchor:
        '        async resolve(secretRef) {\n' +
        '          return callHost("secrets.resolve", { secretRef });\n' +
        '        }',
      replacement:
        '        async resolve(secretRef, opts) {\n' +
        '          return callHost("secrets.resolve", { ...(opts ?? {}), secretRef }); // ' + MARKER + '\n' +
        '        }',
    },
    {
      label: 'sdk-config-get-company',
      anchor:
        '        async get() {\n' +
        '          return callHost("config.get", {});\n' +
        '        }',
      replacement:
        '        async get(companyId) {\n' +
        '          return callHost("config.get", companyId ? { companyId } : {});\n' +
        '        }',
    },
    {
      label: 'is-secret-ref-helper',
      anchor: 'var plugin = definePlugin({',
      replacement:
        'function __pcIsSecretRef(v) {\n' +
        '  if (v && typeof v === "object") return v.type === "secret_ref";\n' +
        '  return typeof v === "string" && ' + UUID + '.test(v.trim());\n' +
        '}\n' +
        'var plugin = definePlugin({',
    },
    {
      label: 'helper-v3-company-scope',
      anchor:
        '    __pcResolveSecret = async (v) => {\n' +
        '      if (!v) return "";\n' +
        '      const s = typeof v === "string" ? v.trim() : "";\n' +
        '      if (' + UUID + '.test(s)) return await ctx.secrets.resolve(s);\n' +
        '      if (typeof v === "object" && v.type === "secret_ref") return await ctx.secrets.resolve(String(v.id ?? v.secretId ?? ""));\n' +
        '      return typeof v === "string" ? v : "";\n' +
        '    };',
      replacement:
        '    __pcResolveSecret = async (v, companyId, configPath) => {\n' +
        '      if (!v) return "";\n' +
        '      if (!__pcIsSecretRef(v)) return typeof v === "string" ? v : "";\n' +
        '      if (!companyId) throw new Error(`${configPath} est un secret Paperclip : sélectionne une company pour lancer le wizard`);\n' +
        '      const ref = typeof v === "object"\n' +
        '        ? { type: "secret_ref", secretId: String(v.secretId ?? v.id ?? ""), version: v.version ?? "latest" }\n' +
        '        : { type: "secret_ref", secretId: v.trim(), version: "latest" };\n' +
        '      return await ctx.secrets.resolve(ref, { companyId, configPath });\n' +
        '    }; // ' + MARKER + ' —',
    },
    {
      label: 'check-auth-company',
      anchor:
        '    ctx.actions.register("check-auth", async () => {\n' +
        '      const cfg = await ctx.config.get() ?? {};',
      replacement:
        '    ctx.actions.register("check-auth", async (params) => {\n' +
        '      const cfg = await ctx.config.get(params?.companyId) ?? {};',
    },
    {
      label: 'check-auth-password',
      anchor: 'password: await __pcResolveSecret(cfg.paperclipPassword)',
      replacement: 'password: await __pcResolveSecret(cfg.paperclipPassword, params?.companyId, "paperclipPassword")',
    },
    {
      label: 'ai-chat-company',
      anchor:
        '        const cfg = await ctx.config.get() ?? {};\n' +
        '        const apiKey = await __pcResolveSecret(cfg.anthropicApiKey);',
      replacement:
        '        const cfg = await ctx.config.get(params?.companyId) ?? {};\n' +
        '        const apiKey = await __pcResolveSecret(cfg.anthropicApiKey, params?.companyId, "anthropicApiKey");',
    },
    {
      label: 'start-provision-company',
      anchor:
        '        const cfg = await ctx.config.get() ?? {};\n' +
        '        const paperclipUrl = cfg.paperclipUrl || process.env.PAPERCLIP_PUBLIC_URL || "http://localhost:3100";\n' +
        '        const paperclipEmail = cfg.paperclipEmail || "";\n' +
        '        const paperclipPassword = await __pcResolveSecret(cfg.paperclipPassword);',
      replacement:
        '        const cfg = await ctx.config.get(params?.companyId) ?? {};\n' +
        '        const paperclipUrl = cfg.paperclipUrl || process.env.PAPERCLIP_PUBLIC_URL || "http://localhost:3100";\n' +
        '        const paperclipEmail = cfg.paperclipEmail || "";\n' +
        '        const paperclipPassword = await __pcResolveSecret(cfg.paperclipPassword, params?.companyId, "paperclipPassword");',
    },
    {
      label: 'validate-config-no-company',
      anchor: '  async onValidateConfig(config) {\n',
      replacement:
        '  async onValidateConfig(config) {\n' +
        '    // validateConfig ne reçoit aucune company : un secret ne peut pas être résolu ici.\n' +
        '    if (__pcIsSecretRef(config.paperclipPassword)) {\n' +
        '      return { ok: true, warnings: ["paperclipPassword est un secret Paperclip : non vérifiable depuis Test, il sera vérifié au lancement du wizard."] };\n' +
        '    }\n',
    },
  ],
});
NODE

# Passe 8 : déclarer la capacité secrets.read-ref (voir l'en-tête, point 8).
MANIFEST="$(dirname "$WORKER")/manifest.js"
[ -f "$MANIFEST" ] || { pc_warn "manifest.js introuvable — capacité secrets.read-ref non ajoutée"; exit 0; }
MANIFEST_FILE="$MANIFEST" PC_PATCH_LIB="$PC_PATCH_LIB" node <<'NODE' || { pc_warn "manifest capability patch failed — continuing startup"; exit 0; }
const { applyPatch } = require(process.env.PC_PATCH_LIB);
const MARKER = 'PC_COMPANY_WIZARD_READ_REF_v1';

applyPatch({
  file: process.env.MANIFEST_FILE,
  marker: MARKER,
  mode: 'soft',
  edits: [
    {
      label: 'capability-secrets-read-ref',
      anchor: '  capabilities: [\n',
      replacement: '  capabilities: [\n    "secrets.read-ref", // ' + MARKER + '\n',
    },
  ],
});
NODE

# Passe 9 : écho de paperclipInvocationId (voir l'en-tête, point 9).
WORKER_FILE="$WORKER" PC_PATCH_LIB="$PC_PATCH_LIB" node <<'NODE' || { pc_warn "invocation-id patch failed — continuing startup"; exit 0; }
const { applyPatch } = require(process.env.PC_PATCH_LIB);
const MARKER = 'PC_COMPANY_WIZARD_INVOCATION_ID_v1';

applyPatch({
  file: process.env.WORKER_FILE,
  marker: MARKER,
  mode: 'soft',
  edits: [
    {
      label: 'import-async-local-storage',
      anchor: 'import { createInterface } from "node:readline";',
      replacement:
        'import { createInterface } from "node:readline";\n' +
        'import { AsyncLocalStorage as __PcAsyncLocalStorage } from "node:async_hooks"; // ' + MARKER + '\n' +
        'const __pcInvocationStorage = new __PcAsyncLocalStorage();',
    },
    {
      label: 'call-host-echo-id',
      anchor:
        '        const request = createRequest(method, params, id);\n' +
        '        sendMessage(request);',
      replacement:
        '        const __pcInv = __pcInvocationStorage.getStore();\n' +
        '        const request = { ...createRequest(method, params, id), ...(__pcInv ? { paperclipInvocationId: __pcInv.id } : {}) };\n' +
        '        sendMessage(request);',
    },
    {
      label: 'notify-host-echo-id',
      anchor: '      sendMessage(createNotification(method, params));',
      replacement:
        '      const __pcInv = __pcInvocationStorage.getStore();\n' +
        '      sendMessage({ ...createNotification(method, params), ...(__pcInv ? { paperclipInvocationId: __pcInv.id } : {}) });',
    },
    {
      label: 'host-request-run-in-invocation',
      anchor: '      const result = await dispatchMethod(method, params);',
      replacement:
        '      const result = request.paperclipInvocation\n' +
        '        ? await __pcInvocationStorage.run(request.paperclipInvocation, () => dispatchMethod(method, params))\n' +
        '        : await dispatchMethod(method, params);',
    },
  ],
});
NODE
