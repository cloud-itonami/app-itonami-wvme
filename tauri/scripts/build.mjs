// Package the static bundle as the Tauri frontend: copy it, add the pinned consent
// broker, the host adapter and the descriptor, and derive a per-page CSP from the
// declared service origins. It changes nothing in the source bundle.
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { descriptor, requestedCapabilities } from "../src/descriptor.mjs";
import { clientRuntimeConnectSrc, clientRuntimeProblems } from "../vendor/kotoba-client-runtime.js";

const here = fileURLToPath(new URL("../", import.meta.url));
const source = path.resolve(process.env.STATIC_SRC ?? path.join(here, "../appview/wvme-mcp-component/cljs/public"));
const out = path.resolve(process.env.TAURI_DIST ?? path.join(here, "dist"));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fail = (message) => { console.error(`tauri build: ${message}`); process.exit(1); };

const pins = JSON.parse(await readFile(path.join(here, "vendor/PINS.json"), "utf8"));
for (const [name, digest] of Object.entries(pins.files)) {
  if (sha(await readFile(path.join(here, "vendor", name))) !== digest) fail(`canonical runtime pin drift: ${name}`);
}
try { await stat(path.join(source, "index.html")); } catch { fail(`${path.join(source, "index.html")} is missing`); }

const capabilities = requestedCapabilities(descriptor);
const problems = clientRuntimeProblems(descriptor, capabilities, ["https://tauri.localhost"]);
if (problems.length) fail(`descriptor is invalid: ${JSON.stringify(problems)}`);
const connect = clientRuntimeConnectSrc(descriptor, capabilities, [], ["https://tauri.localhost"]);

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await cp(source, out, { recursive: true });
// The oracle-built release bundle is committed under tauri/bundle (the source repo ignores public/js).
await cp(path.join(here, "bundle"), out, { recursive: true });
await cp(path.join(here, "vendor/kotoba-client-runtime.js"), path.join(out, "runtime.js"));
await cp(path.join(here, "vendor/kotoba-client-consent.css"), path.join(out, "runtime-consent.css"));
await cp(path.join(here, "src/host.js"), path.join(out, "host.js"));
await writeFile(path.join(out, "descriptor.json"), JSON.stringify(descriptor, null, 2) + "\n");
await writeFile(path.join(out, "descriptor.js"), `export default ${JSON.stringify(descriptor)};\n`);

const htmlFiles = [];
const walk = async (dir, collect) => {
  for (const entry of await readdir(path.join(out, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) await walk(rel, collect); else collect(rel);
  }
};
await walk("", (rel) => { if (rel.endsWith(".html")) htmlFiles.push(rel); });
const hasWasm = (await (async () => { const all = []; await walk("", (rel) => all.push(rel)); return all; })()).some((rel) => rel.endsWith(".wasm"));
for (const rel of htmlFiles) {
  let html = await readFile(path.join(out, rel), "utf8");
  if (/<meta[^>]+http-equiv=["']Content-Security-Policy/iu.test(html)) fail(`${rel} already carries a CSP; refusing to merge policies`);
  if (!/<head[^>]*>/iu.test(html)) fail(`${rel} has no <head>`);
  if (/\son(?:click|load|error|submit|change|input|mouse\w+|key\w+|focus|blur)\s*=/iu.test(html)) fail(`${rel} has an inline event handler, which cannot be hashed`);
  const scriptHashes = [...html.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/giu)].map((m) => `'sha256-${createHash("sha256").update(m[1]).digest("base64")}'`);
  const hashes = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/giu)].map((m) => `'sha256-${createHash("sha256").update(m[1]).digest("base64")}'`);
  const inlineAttrs = /\sstyle=/iu.test(html);
  const csp = ["default-src 'none'", `script-src 'self' ${[...scriptHashes, ...(hasWasm ? ["'wasm-unsafe-eval'"] : [])].join(" ")}`.trim(), `style-src 'self' ${hashes.join(" ")}`.trim(),
    ...(inlineAttrs ? ["style-src-attr 'unsafe-inline'"] : []), "img-src 'self' data:", "font-src 'self'",
    `${connect === "connect-src 'none'" ? "connect-src 'self'" : connect.replace("connect-src ", "connect-src 'self' ")} ipc: http://ipc.localhost`,
    "object-src 'none'", "frame-src 'none'", "base-uri 'none'", "form-action 'none'"].join("; ");
  html = html.replace(/<head([^>]*)>/iu, `<head$1><meta http-equiv="Content-Security-Policy" content="${csp}"><link rel="stylesheet" href="/runtime-consent.css"><script type="module" src="/host.js"></script>`);
  await writeFile(path.join(out, rel), html);
}

const files = {};
await walk("", (rel) => { files[rel] = null; });
for (const rel of Object.keys(files)) if (rel !== "release.json") files[rel] = sha(await readFile(path.join(out, rel)));
delete files["release.json"];
await writeFile(path.join(out, "release.json"), JSON.stringify({ schema: "awai.app.artifact.v1", id: "cloud.itonami.wvme", tauri: "3.0.0-alpha.6", runtimePins: pins, files }, null, 2) + "\n");
console.log(`wvme Tauri frontend: ${Object.keys(files).length} files, ${htmlFiles.length} pages; ${connect}`);
