import { interpolateEnv } from "../config.js";
import { fixupAnthropicStream } from "../stream-fixup.js";
import { getCapabilities, stripUnsupportedContent } from "../capabilities.js";

// Ollama (>= v0.14) serves the Anthropic Messages API at /v1/messages.
// Local: http://localhost:11434. Cloud: https://ollama.com (auth via x-api-key).
//
// We additionally:
//   - Probe model capabilities via /api/show, caching the result.
//   - Strip image content blocks from messages going to text-only models
//     (otherwise text-only models 400 on conversation history that contains
//     prior image attachments).
//   - Wrap streaming responses in the SSE sanitizer to absorb Ollama's
//     Anthropic-compat parity gaps (orphan content_block_delta / _stop).

export async function dispatch({ provider, modelId, body, path, signal }) {
  const url = new URL(path, provider.baseUrl).toString();

  // If the provider declared an apiKey template that interpolates to empty,
  // surface a clear router-side error instead of forwarding a literal "ollama"
  // string that the remote endpoint will reject as 401. Local Ollama
  // configurations (no apiKey field) keep the legacy "ollama" placeholder.
  let apiKey;
  if (provider.apiKey) {
    apiKey = interpolateEnv(provider.apiKey);
    if (!apiKey) {
      const missing = provider.apiKey.match(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/)?.[1];
      const hint = missing ? ` — env var ${missing} is unset` : "";
      const err = new Error(`provider "${provider.baseUrl}" requires apiKey${hint}`);
      err.httpStatus = 401;
      throw err;
    }
  } else {
    apiKey = "ollama";
  }
  const headers = new Headers({
    "content-type": "application/json",
    "x-api-key": apiKey,
    "anthropic-version": "2023-06-01",
  });

  const caps = await getCapabilities(provider.baseUrl, modelId);
  const { body: cleaned, stripped } = stripUnsupportedContent(body, caps);
  if (stripped > 0) {
    console.error(`[openclaude] stripped ${stripped} image block(s) for text-only model ${modelId}`);
  }
  const outBody = { ...cleaned, model: modelId };

  const upstream = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(outBody),
    signal,
  });

  // Apply the SSE sanitizer only to streaming responses (text/event-stream).
  const ct = upstream.headers.get("content-type") ?? "";
  if (upstream.ok && upstream.body && ct.includes("text/event-stream")) {
    const fixed = fixupAnthropicStream(upstream.body);
    return new Response(fixed, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: upstream.headers,
    });
  }
  return upstream;
}
