// Pass an Anthropic Messages request straight through to api.anthropic.com,
// preserving the Authorization / x-api-key / anthropic-version headers exactly
// as they arrived. If the Authorization carries our discovery sentinel,
// substitute the real OAuth bearer read from ~/.claude/.credentials.json.

import { maybeSubstituteAuth } from "../auth.js";

const PASSTHROUGH_REQUEST_HEADERS = new Set([
  "authorization",
  "x-api-key",
  "anthropic-version",
  "anthropic-beta",
  "anthropic-dangerous-direct-browser-access",
  "user-agent",
  "accept",
  "accept-encoding",
  "content-type",
]);

export async function dispatch({ provider, modelId, body, headers, path, signal }) {
  const url = new URL(path, provider.baseUrl).toString();

  const outHeaders = new Headers();
  for (const [k, v] of Object.entries(headers)) {
    if (PASSTHROUGH_REQUEST_HEADERS.has(k.toLowerCase())) outHeaders.set(k, v);
  }
  if (!outHeaders.has("content-type")) outHeaders.set("content-type", "application/json");
  outHeaders.delete("host");

  // Sentinel → real OAuth swap. No-op if Authorization doesn't carry the sentinel.
  await maybeSubstituteAuth(outHeaders);

  const outBody = { ...body, model: modelId };

  return fetch(url, {
    method: "POST",
    headers: outHeaders,
    body: JSON.stringify(outBody),
    signal,
  });
}

