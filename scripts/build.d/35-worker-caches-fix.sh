#!/usr/bin/env bash
# 35-worker-caches-fix.sh
# Fixes Paperclip UI sandboxed adapter-parser worker:
# 1. Injects synchronous `qveysRouterAdapter` directly into Paperclip's built-in adapter registry (index-*.js)
#    to eliminate the asynchronous Web Worker re-render cascade loop completely.
# 2. Deactivates and auto-unregisters `sw.js` (Service Worker) to prevent CORS / Cloudflare Access redirect deadlocks.
# 3. Removes `<link rel="manifest">` from `index.html` to eliminate CSP / CORS blocking.
# 4. Injects cache-busting query parameter `?v=qveys-router-v2` in index.html to force browser cache refresh.
set -uo pipefail

UI_DIST="/usr/local/lib/node_modules/paperclipai/node_modules/@paperclipai/server/ui-dist"
[ -d "$UI_DIST" ] || exit 0

PARSER_SRC="/opt/paperclip/adapter-qveys-agent-router/ui-parser.cjs"
[ -f "$PARSER_SRC" ] || PARSER_SRC="/docker/paperclip/adapter-qveys-agent-router/ui-parser.cjs"
[ -f "$PARSER_SRC" ] || PARSER_SRC="/paperclip/adapter-plugins/node_modules/@paperclip-custom/adapter-qveys-agent-router/ui-parser.cjs"

node -e '
const fs = require("fs");
const path = require("path");

const uiDist = process.argv[1];
const parserSrcPath = process.argv[2];

if (!fs.existsSync(uiDist) || !fs.existsSync(parserSrcPath)) {
  process.exit(0);
}

const uiParser = fs.readFileSync(parserSrcPath, "utf8");
const assetsDir = path.join(uiDist, "assets");

for (const f of fs.readdirSync(assetsDir)) {
  if (f.startsWith("index-") && f.endsWith(".js")) {
    const fp = path.join(assetsDir, f);
    let src = fs.readFileSync(fp, "utf8");
    let modified = false;

    if (src.includes("self.caches = _undefined;")) {
      src = src.replace("self.caches = _undefined;", "try{self.caches=_undefined}catch(e){}");
      modified = true;
    }
    if (src.includes("self.indexedDB = _undefined;")) {
      src = src.replace("self.indexedDB = _undefined;", "try{self.indexedDB=_undefined}catch(e){}");
      modified = true;
    }
    if (src.includes("navigator.serviceWorker.register(\"/sw.js\")")) {
      src = src.replace("navigator.serviceWorker.register(\"/sw.js\")", "navigator.serviceWorker.getRegistrations().then(r=>r.forEach(x=>x.unregister()))");
      modified = true;
    }

    const searchStr = "for(const e of[HWt,cHt,CHt,PHt,kZt,DZt,WZt,rXt,gXt,NXt,ZHt,zXt,Y$,YXt])";
    if (src.includes(searchStr)) {
      const injection = `
const qveysRouterParser = (function() {
  const module = { exports: {} };
  const exports = module.exports;
  ${uiParser};
  return module.exports.parseStdoutLine || exports.parseStdoutLine || parseStdoutLine;
})();
const qveysRouterAdapter = {
  type: "qveys_agent_router",
  label: "Qveys Agent Router",
  parseStdoutLine: qveysRouterParser,
  ConfigFields: xw,
  buildAdapterConfig: hA
};
for(const e of[HWt,cHt,CHt,PHt,kZt,DZt,WZt,rXt,gXt,NXt,ZHt,zXt,Y$,YXt,qveysRouterAdapter])`;
      src = src.replace(searchStr, injection);
      modified = true;
    }

    if (modified) {
      fs.writeFileSync(fp, src, "utf8");
      console.log("[worker-caches-fix] patched bundle:", f);
    }
  }
}

// sw.js cleaner
const swPath = path.join(uiDist, "sw.js");
if (fs.existsSync(swPath)) {
  const swCleaner = `self.addEventListener("install",e=>self.skipWaiting());self.addEventListener("activate",e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.map(x=>caches.delete(x)))).then(()=>self.registration.unregister()));self.clients.claim()});self.addEventListener("fetch",e=>{return});`;
  fs.writeFileSync(swPath, swCleaner, "utf8");
  console.log("[worker-caches-fix] patched sw.js cleaner");
}

// index.html manifest cleaner and cache buster
const htmlPath = path.join(uiDist, "index.html");
if (fs.existsSync(htmlPath)) {
  let html = fs.readFileSync(htmlPath, "utf8");
  if (html.includes("<link rel=\"manifest\"")) {
    html = html.replace(/<link rel="manifest"[^>]*>/g, "");
  }
  if (html.includes("/assets/index-BxyLrE8J.js\"")) {
    html = html.replace("/assets/index-BxyLrE8J.js\"", "/assets/index-BxyLrE8J.js?v=qveys-router-v2\"");
  }
  fs.writeFileSync(htmlPath, html, "utf8");
  console.log("[worker-caches-fix] updated index.html with cache buster");
}
' "$UI_DIST" "$PARSER_SRC"

exit 0
