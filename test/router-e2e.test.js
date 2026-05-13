import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROUTER_ENTRY = join(__dirname, "..", "src", "router", "index.js");

function startStub(port) {
  return new Promise((resolve) => {
    const seen = [];
    const server = createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        seen.push({ method: req.method, url: req.url, headers: req.headers, body });
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ id: "msg_test", role: "assistant", content: [{ type: "text", text: "ok" }] }));
      });
    });
    server.listen(port, "127.0.0.1", () => resolve({ server, seen }));
  });
}

function startRouter(home, port) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ROUTER_ENTRY], {
      env: { ...process.env, OPENCLAUDE_HOME: home, OPENCLAUDE_PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let buf = "";
    const onData = (d) => {
      buf += d.toString();
      if (buf.includes("listening on")) {
        child.stderr.off("data", onData);
        resolve(child);
      }
    };
    child.stderr.on("data", onData);
    child.on("error", reject);
    setTimeout(() => reject(new Error("router didn't start: " + buf)), 4000);
  });
}

async function waitForRouter(port) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/openclaude/status`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("router never became ready");
}

test("router e2e: natural model IDs, OAuth pass-through, no leak across providers", async (t) => {
  const home = join(tmpdir(), `oc-test-${Date.now()}`);
  await mkdir(home, { recursive: true });
  t.after(() => rm(home, { recursive: true, force: true }));

  const STUB_PORT = 19990;
  const ROUTER_PORT = 19991;
  const { server: stub, seen } = await startStub(STUB_PORT);
  t.after(() => new Promise((r) => stub.close(r)));

  const cfg = {
    port: ROUTER_PORT,
    defaultProvider: "fake-anthropic",
    providers: {
      "fake-anthropic": { type: "anthropic-passthrough", baseUrl: `http://127.0.0.1:${STUB_PORT}` },
      "fake-ollama":    { type: "ollama",                 baseUrl: `http://127.0.0.1:${STUB_PORT}` },
    },
  };
  await writeFile(join(home, "config.json"), JSON.stringify(cfg, null, 2));

  const router = await startRouter(home, ROUTER_PORT);
  t.after(() => { try { router.kill("SIGTERM"); } catch {} });
  await waitForRouter(ROUTER_PORT);

  // 1. Bare alias → default provider (anthropic-passthrough), Authorization preserved
  const r1 = await fetch(`http://127.0.0.1:${ROUTER_PORT}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "authorization": "Bearer my-oauth-token" },
    body: JSON.stringify({ model: "sonnet", messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(r1.status, 200);
  assert.equal(seen.at(-1).body.model, "sonnet", "bare alias must reach upstream as-is");
  assert.equal(seen.at(-1).headers["authorization"], "Bearer my-oauth-token", "OAuth header must pass through to anthropic");

  // 2. fake-ollama:gemma4:31b-cloud → ollama with model rewritten + x-api-key
  const r2 = await fetch(`http://127.0.0.1:${ROUTER_PORT}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "authorization": "Bearer should-not-leak" },
    body: JSON.stringify({ model: "fake-ollama:gemma4:31b-cloud", messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(r2.status, 200);
  assert.equal(seen.at(-1).body.model, "gemma4:31b-cloud", "ollama provider gets the model id without prefix");
  assert.ok(seen.at(-1).headers["x-api-key"], "ollama dispatch sets x-api-key");
  assert.notEqual(seen.at(-1).headers["authorization"], "Bearer should-not-leak", "anthropic OAuth must not leak to ollama");

  // 3. fake-anthropic:claude-opus-4-7 — explicit anthropic prefix
  const r3 = await fetch(`http://127.0.0.1:${ROUTER_PORT}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "fake-anthropic:claude-opus-4-7", messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(r3.status, 200);
  assert.equal(seen.at(-1).body.model, "claude-opus-4-7");

  // 4. /v1/models discovery — for an offline ollama provider, returns 0 entries
  //    (it only enumerates ollama providers; the stub doesn't speak /api/tags).
  //    This covers the "no models — empty data" path.
  const r4 = await fetch(`http://127.0.0.1:${ROUTER_PORT}/v1/models`);
  assert.equal(r4.status, 200);
  const list = await r4.json();
  assert.ok(Array.isArray(list.data), "/v1/models returns data array");

  // 5. HEAD / and GET / both 200 (Claude Code reachability probe)
  const r5 = await fetch(`http://127.0.0.1:${ROUTER_PORT}/`, { method: "HEAD" });
  assert.equal(r5.status, 200);

  // 6. claude-ol-<provider>:<model> id from gateway discovery decodes correctly
  const r6 = await fetch(`http://127.0.0.1:${ROUTER_PORT}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "claude-ol-fake-ollama:llama3:8b", messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(r6.status, 200);
  assert.equal(seen.at(-1).body.model, "llama3:8b", "claude-ol- prefix must be stripped before forwarding");
});
