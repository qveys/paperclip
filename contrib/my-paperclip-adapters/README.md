# my-paperclip adapters (archived source)

Imported unchanged from `qveys/my-paperclip@924f9fb` (`adapters/`) when that
repository was retired. **Not wired into this fork's build**: they targeted the
`ghcr.io/hostinger/hvps-paperclip` image and were registered by patching its
compiled server registry.

- `qwen-local/index.js` — `qwen_local` adapter for the Qwen Code CLI.
- `vibe-local/index.js` — `vibe_local` adapter for the Mistral Vibe CLI.
- `patch-registry.mjs` — idempotent patch adding both adapters to the server
  adapter registry of the published image.
- `package.json` — marks the directory as ES modules.

The original wiring (from my-paperclip's Dockerfile) copied the adapters to
`/usr/local/lib/paperclip-custom-adapters/`, symlinked the server's
`dist/adapters/process` and `dist/adapters/utils.js` next to them, then ran
`node /tmp/patch-registry.mjs`. To enable one here, port it to the vendored
adapter layout in `scripts/adapters/adapter-<name>-local/` instead.
