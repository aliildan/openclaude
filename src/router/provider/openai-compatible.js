import { interpolateEnv } from "../config.js";
import { fixupAnthropicStream } from "../stream-fixup.js";
import {
  anthropicMessageToSse,
  anthropicToOpenAIRequest,
  estimateAnthropicInputTokens,
  openAIErrorToAnthropic,
  openAIJsonToAnthropic,
  openAIStreamToAnthropic,
} from "../openai-compat.js";

function joinUrl(baseUrl, path) {
  return `${String(baseUrl).replace(/\/+$/, "")}/${String(path).replace(/^\/+/, "")}`;
}

function resolveApiKey(provider) {
  const template = provider.apiKey ?? "$AGNES_API_KEY";
  const value = interpolateEnv(template);
  if (!value) {
    const match = String(template).match(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/);
    const err = new Error(`OpenAI-compatible provider API key is empty${match ? ` — env var ${match[1]} is unset` : ""}`);
    err.httpStatus = 401;
    throw err;
  }
  return value;
}

function jsonResponse(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

async function parseMaybeJson(response) {
  const text = await response.text();
  if (!text) return { text: "", json: null };
  try { return { text, json: JSON.parse(text) }; }
  catch { return { text, json: null }; }
}
// An HTTP-200 body may still carry an OpenAI-style {error:{...}} object, or no
// choices at all. Convert both into an Anthropic error instead of handing an
// empty "success" message back to Claude Code.
function upstreamBodyError(json) {
  const e = json?.error;
  if (e) return typeof e === "string" ? e : (e.message ?? e.type ?? "Upstream error");
  if (!Array.isArray(json?.choices) || json.choices.length === 0) {
    return "Upstream response contained no choices";
  }
  return null;
}

// Call the upstream with a timeout that only covers the connect + response-
// headers phase. The timer is cleared as soon as headers arrive, so a
// legitimately long streaming body is never cut off. This guards against a
// hung connection (the free Agnes pool can stall under load) that would
// otherwise make Claude Code wait forever. A client disconnect still aborts
// immediately. A timeout/network failure is returned as a synthetic 5xx
// Response so the existing `!upstream.ok` error path handles it uniformly.
async function fetchUpstream(url, init, clientSignal, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  const timeoutMessage = `OpenAI-compatible upstream returned no response headers within ${timeoutMs}ms`;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(timeoutMessage));
  }, timeoutMs);
  const onClientAbort = () => controller.abort(clientSignal?.reason);
  if (clientSignal) {
    if (clientSignal.aborted) controller.abort(clientSignal.reason);
    else clientSignal.addEventListener("abort", onClientAbort, { once: true });
  }
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (clientSignal?.aborted) throw err; // client hung up — upper layer logs quietly
    const status = timedOut ? 504 : 502;
    // On timeout use our own stable message: the underlying fetch's abort
    // error message is implementation-defined and not guaranteed to carry it.
    const detail = timedOut ? timeoutMessage : `Upstream fetch failed: ${err?.message ?? err}`;
    return new Response(JSON.stringify(openAIErrorToAnthropic(status, detail)), {
      status,
      headers: { "content-type": "application/json" },
    });
  } finally {
    clearTimeout(timer);
    clientSignal?.removeEventListener?.("abort", onClientAbort);
  }
}

export async function dispatch({ provider, modelId, body, path, signal }) {
  if (path.endsWith("/count_tokens")) {
    return jsonResponse({ input_tokens: estimateAnthropicInputTokens(body) });
  }

  const apiKey = resolveApiKey(provider);
  const chatPath = provider.chatPath ?? "chat/completions";
  const url = joinUrl(provider.baseUrl, chatPath);
  const openAIBody = anthropicToOpenAIRequest(body, modelId, provider);

  const headers = new Headers({
    "content-type": "application/json",
    "authorization": `Bearer ${apiKey}`,
    "accept": openAIBody.stream ? "text/event-stream" : "application/json",
  });
  if (provider.headers && typeof provider.headers === "object") {
    for (const [k, raw] of Object.entries(provider.headers)) {
      const value = interpolateEnv(raw);
      if (value) headers.set(k, value);
    }
  }

  const timeoutMs = Number.isFinite(provider.timeoutMs) && provider.timeoutMs > 0
    ? provider.timeoutMs
    : 60000;
  const upstream = await fetchUpstream(url, {
    method: "POST",
    headers,
    body: JSON.stringify(openAIBody),
  }, signal, timeoutMs);

  if (!upstream.ok) {
    const parsed = await parseMaybeJson(upstream);
    return jsonResponse(
      openAIErrorToAnthropic(upstream.status, parsed.json ?? parsed.text),
      upstream.status,
    );
  }

  const contentType = upstream.headers.get("content-type") ?? "";
  if (openAIBody.stream && upstream.body && contentType.includes("text/event-stream")) {
    const converted = openAIStreamToAnthropic(upstream.body, { model: modelId });
    const fixed = fixupAnthropicStream(converted);
    return new Response(fixed, {
      status: 200,
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        "connection": "keep-alive",
      },
    });
  }

  const parsed = await parseMaybeJson(upstream);
  if (!parsed.json) {
    return jsonResponse(openAIErrorToAnthropic(502, `Invalid JSON from OpenAI-compatible upstream: ${parsed.text.slice(0, 300)}`), 502);
  }
  const bodyError = upstreamBodyError(parsed.json);
  if (bodyError) {
    return jsonResponse(openAIErrorToAnthropic(502, bodyError), 502);
  }
  const message = openAIJsonToAnthropic(parsed.json, modelId);

  if (openAIBody.stream) {
    const fixed = fixupAnthropicStream(anthropicMessageToSse(message));
    return new Response(fixed, {
      status: 200,
      headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" },
    });
  }
  return jsonResponse(message);
}
