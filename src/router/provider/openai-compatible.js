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

  const upstream = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(openAIBody),
    signal,
  });

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
