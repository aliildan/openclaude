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

// Upstream stub that can either answer normally or simulate an upstream that
// dies mid-stream: it sends SSE headers + a partial chunk, then abruptly
// destroys the socket. That reproduces the production failure where Anthropic's
// streamed body terminates (undici BodyTimeoutError / premature close) after
// the router has already started forwarding bytes to the client.
function startStub(port) {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        if (typeof body.model === "string" && body.model.includes("diemid")) {
          res.statusCode = 200;
          res.setHeader("content-type", "text/event-stream");
          res.write("event: message_start\ndata: {}\n\n");
          // Give the router time to read+forward the first chunk (so its
          // response headers are flushed) before the upstream socket dies.
          setTimeout(() => res.socket.destroy(), 50);
          return;
        }
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ id: "msg_test", role: "assistant", content: [{ type: "text", text: "ok" }] }));
      });
    });
    server.listen(port, "127.0.0.1", () => resolve({ server }));
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

test("router survives an upstream error that occurs after streaming has started", async (t) => {
  const home = join(tmpdir(), `oc-stream-err-${Date.now()}`);
  await mkdir(home, { recursive: true });
  t.after(() => rm(home, { recursive: true, force: true }));

  const STUB_PORT = 19992;
  const ROUTER_PORT = 19993;
  const { server: stub } = await startStub(STUB_PORT);
  t.after(() => new Promise((r) => stub.close(r)));

  const cfg = {
    port: ROUTER_PORT,
    defaultProvider: "fake-anthropic",
    providers: {
      "fake-anthropic": { type: "anthropic-passthrough", baseUrl: `http://127.0.0.1:${STUB_PORT}` },
    },
  };
  await writeFile(join(home, "config.json"), JSON.stringify(cfg, null, 2));

  const router = await startRouter(home, ROUTER_PORT);
  let exited = false;
  router.on("exit", () => { exited = true; });
  t.after(() => { try { router.kill("SIGTERM"); } catch {} });
  await waitForRouter(ROUTER_PORT);

  // Request #1: triggers a mid-stream upstream death. The client may see a
  // truncated/aborted body — that's fine. What must NOT happen is the router
  // process crashing.
  try {
    const r1 = await fetch(`http://127.0.0.1:${ROUTER_PORT}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "diemid-model", messages: [{ role: "user", content: "hi" }] }),
    });
    await r1.text().catch(() => {});
  } catch {
    // network-level abort of the partial stream is acceptable
  }

  // Give any (incorrect) crash a moment to land.
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(exited, false, "router daemon must stay alive after a mid-stream upstream error");

  // Request #2: a normal request must still succeed, proving the daemon is
  // healthy and still serving.
  const r2 = await fetch(`http://127.0.0.1:${ROUTER_PORT}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "sonnet", messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(r2.status, 200, "router must keep serving requests after a mid-stream upstream error");
});
