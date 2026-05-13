import { createServer } from "node:http";
import { loadConfig, parseModelTarget, interpolateEnv } from "./config.js";
import { listLocalOllamaModels } from "../cli/ollama.js";
import { sanitizeToolIds, sanitizeThinkingBlocks } from "./sanitize.js";
import * as anthropicPassthrough from "./provider/anthropic-passthrough.js";
import * as ollama from "./provider/ollama.js";

// Claude Code's discovery filter only keeps /v1/models entries whose id starts
// with "claude" or "anthropic". So Ollama entries are exposed as
// "claude-ol-<provider>-<model>" — readable enough that the chat display
// (which echoes the raw id) still tells you which model is active.
const OLLAMA_DISCOVERY_PREFIX = "claude-ol-";

function ollamaDiscoveryId(providerId, modelName) {
  // No encoding — colons and dots are valid in Anthropic model ids
  // (e.g. "claude-opus-4-7[1m]"), and Claude Code passes user-typed strings
  // through unvalidated.
  return `${OLLAMA_DISCOVERY_PREFIX}${providerId}:${modelName}`;
}

function decodeOllamaDiscoveryId(model) {
  if (typeof model !== "string" || !model.startsWith(OLLAMA_DISCOVERY_PREFIX)) return null;
  return model.slice(OLLAMA_DISCOVERY_PREFIX.length); // → "<provider>:<model>"
}

const PROVIDER_IMPL = {
  "anthropic-passthrough": anthropicPassthrough,
  ollama,
};

function log(...args) {
  if (process.env.OPENCLAUDE_QUIET) return;
  console.error("[openclaude]", ...args);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw Object.assign(new Error("Invalid JSON body"), { httpStatus: 400, cause: err });
  }
}

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(payload));
}

async function handleMessages(req, res, cfg) {
  const body = await readJsonBody(req);
  if (typeof body.model !== "string" || body.model.length === 0) {
    return sendJson(res, 400, { type: "error", error: { type: "invalid_request_error", message: "missing model" } });
  }

  // Strip the claude-ol- discovery prefix if present, so an entry chosen from
  // gateway-discovered /v1/models routes correctly.
  const decoded = decodeOllamaDiscoveryId(body.model);
  if (decoded) body.model = decoded;

  // Clean up any tool_use ids in the conversation history that were generated
  // by upstreams with looser id rules (e.g. Ollama's compat layer may emit
  // ids containing dots/colons that Anthropic rejects).
  const sanitized = sanitizeToolIds(body);
  if (sanitized.fixed > 0) {
    log(`sanitized ${sanitized.fixed} dirty tool_use id(s) in conversation history`);
  }
  Object.assign(body, sanitized.body);

  // Drop thinking blocks whose signature looks fake (non-Anthropic origin).
  // Anthropic validates signatures on replay; non-Anthropic upstreams emit
  // empty/short signatures that get rejected.
  const dethought = sanitizeThinkingBlocks(body);
  if (dethought.fixed > 0) {
    log(`dropped ${dethought.fixed} thinking block(s) with non-Anthropic signature`);
  }
  Object.assign(body, dethought.body);

  const { providerId, modelId } = parseModelTarget(body.model, cfg);
  const provider = cfg.providers?.[providerId];
  if (!provider) {
    return sendJson(res, 400, { type: "error", error: { type: "invalid_request_error", message: `Unknown provider "${providerId}" — check ${cfg.configPath ?? "config.json"}` } });
  }
  const impl = PROVIDER_IMPL[provider.type];
  if (!impl) {
    return sendJson(res, 400, { type: "error", error: { type: "invalid_request_error", message: `Provider type "${provider.type}" not supported` } });
  }

  log("→", `${providerId}:${modelId}`);
  body.model = modelId;

  // When the client disconnects mid-stream (Ctrl+C in Claude Code, network drop),
  // abort the upstream fetch instead of draining bytes to a dead socket. Without
  // this, an Ollama Cloud stream that takes 60s to finish keeps consuming quota
  // after the user has already cancelled.
  const controller = new AbortController();
  const onClientClose = () => controller.abort();
  req.once("close", onClientClose);

  let reader = null;
  try {
    const upstream = await impl.dispatch({
      provider,
      modelId,
      body,
      headers: req.headers,
      path: "/v1/messages",
      signal: controller.signal,
    });

    log(`← ${providerId}:${modelId} status ${upstream.status}`);
    res.statusCode = upstream.status;
    for (const [k, v] of upstream.headers.entries()) {
      if (k.toLowerCase() === "content-encoding") continue;
      if (k.toLowerCase() === "content-length") continue;
      res.setHeader(k, v);
    }

    // For non-2xx non-streaming responses, peek the body once and log a snippet
    // before forwarding it on. Diagnoses the common cause of retry loops
    // (401 unauthorized, 404 model not found, 400 invalid body) without
    // needing tcpdump.
    const ct = upstream.headers.get("content-type") ?? "";
    if (upstream.body && !upstream.ok && !ct.includes("text/event-stream")) {
      const buf = await upstream.arrayBuffer();
      const text = Buffer.from(buf).toString("utf8");
      log(`!! upstream error body: ${text.slice(0, 400)}${text.length > 400 ? "…" : ""}`);
      res.end(Buffer.from(buf));
    } else if (upstream.body) {
      reader = upstream.body.getReader();
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
      res.end();
    } else {
      res.end();
    }
  } catch (err) {
    // If the abort fired, the AbortError landed here — that's expected, not an
    // upstream failure. Anything else propagates to the outer error handler.
    if (controller.signal.aborted) {
      log("client disconnected; upstream fetch aborted");
      return;
    }
    throw err;
  } finally {
    req.off("close", onClientClose);
    if (reader) reader.cancel().catch(() => {});
  }
}

// Build the /v1/models response Claude Code consumes during gateway discovery.
// Each Ollama model from each ollama-typed provider becomes one picker entry.
// The id MUST start with "claude" or "anthropic" to survive Claude Code's
// discovery filter, hence the OLLAMA_DISCOVERY_PREFIX wrapper.
async function handleModels(_req, res, cfg) {
  log("← /v1/models discovery");
  const data = [];
  const date = new Date().toISOString();

  for (const [providerId, provider] of Object.entries(cfg.providers ?? {})) {
    if (provider.type !== "ollama") continue;
    // If a provider declared an apiKey template (e.g. "$OLLAMA_API_KEY") but
    // the env var is unset, the provider would 401 on every call. Skip it
    // entirely so we don't pollute the picker with unreachable entries.
    if (provider.apiKey && !interpolateEnv(provider.apiKey)) {
      log(`skipping discovery for "${providerId}" — apiKey template "${provider.apiKey}" resolves to empty`);
      continue;
    }
    let models = [];
    try { models = await listLocalOllamaModels(provider.baseUrl); } catch { /* offline ok */ }
    for (const m of models) {
      const id = ollamaDiscoveryId(providerId, m.name);
      data.push({
        type: "model",
        id,
        display_name: `${m.name} (${providerId})`,
        description: `${providerId} · ${m.parameter_size ?? ""} ${m.family ?? ""}`.trim(),
        created_at: date,
      });
    }
  }

  log(`← /v1/models: returned ${data.length} entries`);
  sendJson(res, 200, { data, has_more: false, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null });
}

export async function createRouter() {
  let cfg = await loadConfig();
  const reload = async () => {
    try { cfg = await loadConfig(); } catch (err) { log("config reload failed:", err.message); }
  };

  const server = createServer(async (req, res) => {
    await reload();
    try {
      const url = new URL(req.url, "http://localhost");
      log(`<- ${req.method} ${url.pathname} (ua=${(req.headers["user-agent"] || "").slice(0, 40)})`);
      if (req.method === "POST" && url.pathname === "/v1/messages") return await handleMessages(req, res, cfg);
      if (req.method === "GET" && (url.pathname === "/v1/models" || url.pathname === "/models")) return await handleModels(req, res, cfg);
      if (req.method === "GET" && url.pathname === "/openclaude/status") {
        return sendJson(res, 200, { ok: true, providers: Object.keys(cfg.providers ?? {}) });
      }
      // HEAD / is Claude Code's reachability probe — answer 200.
      if (req.method === "HEAD" || (req.method === "GET" && url.pathname === "/")) {
        res.statusCode = 200;
        return res.end();
      }
      log(`!! 404 for ${req.method} ${url.pathname}`);
      sendJson(res, 404, { type: "error", error: { type: "not_found_error", message: `No route for ${req.method} ${url.pathname}` } });
    } catch (err) {
      log("error:", err);
      const status = err.httpStatus ?? 500;
      sendJson(res, status, { type: "error", error: { type: "router_error", message: err.message } });
    }
  });

  return { server, getConfig: () => cfg };
}

export async function startRouter(port) {
  const { server, getConfig } = await createRouter();
  const listenPort = port ?? getConfig().port ?? 11436;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(listenPort, "127.0.0.1", () => resolve());
  });
  log(`listening on http://127.0.0.1:${listenPort}`);
  return { server, port: listenPort };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const port = process.env.OPENCLAUDE_PORT ? Number(process.env.OPENCLAUDE_PORT) : undefined;
  startRouter(port).catch((err) => { console.error(err); process.exit(1); });
}
