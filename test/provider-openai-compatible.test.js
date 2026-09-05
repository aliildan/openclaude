import test from "node:test";
import assert from "node:assert/strict";
import { dispatch } from "../src/router/provider/openai-compatible.js";

function provider(overrides = {}) {
  return {
    type: "openai-compatible",
    baseUrl: "https://upstream.example.com/v1",
    apiKey: "$OC_PROVIDER_TEST_KEY",
    ...overrides,
  };
}

const minimalBody = { messages: [{ role: "user", content: "hello" }] };

test("dispatch returns 504 instead of hanging forever when upstream sends no headers", async () => {
  process.env.OC_PROVIDER_TEST_KEY = "sk-test";
  const originalFetch = globalThis.fetch;
  // Simulate a hung upstream. Real undici rejects with a generic AbortError
  // whose message does NOT carry our abort reason — so the stable timeout
  // message must come from the adapter, not from the rejection error.
  globalThis.fetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener(
        "abort",
        () => reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" })),
        { once: true },
      );
    });

  const started = Date.now();
  let res;
  try {
    res = await dispatch({
      provider: provider({ timeoutMs: 50 }),
      modelId: "agnes-2.5-flash",
      body: minimalBody,
      path: "/v1/messages",
      signal: undefined,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(res.status, 504);
  const json = await res.json();
  assert.equal(json.type, "error");
  assert.match(json.error.message, /no response headers/);
  assert.ok(Date.now() - started < 500, "should fail fast near the timeout, not hang");
});

test("dispatch still converts a normal OpenAI SSE stream end to end", async () => {
  process.env.OC_PROVIDER_TEST_KEY = "sk-test";
  const originalFetch = globalThis.fetch;
  const sse = [
    `data: ${JSON.stringify({ id: "c1", model: "agnes", choices: [{ delta: { content: "hi" }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
    "data: [DONE]\n\n",
  ].join("");
  globalThis.fetch = async () =>
    new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });

  let res;
  try {
    res = await dispatch({
      provider: provider({ timeoutMs: 1000 }),
      modelId: "agnes-2.5-flash",
      body: { ...minimalBody, stream: true },
      path: "/v1/messages",
      signal: undefined,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);
  const text = await res.text();
  assert.ok(text.includes("event: message_start"));
  assert.ok(text.includes("event: message_stop"));
  assert.ok(text.includes("hi"));
});

async function nonStreamingDispatchWithBody(bodyObj) {
  process.env.OC_PROVIDER_TEST_KEY = "sk-test";
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify(bodyObj), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  try {
    return await dispatch({
      provider: provider({ timeoutMs: 1000 }),
      modelId: "agnes-2.5-flash",
      body: { messages: [], stream: false },
      path: "/v1/messages",
      signal: undefined,
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("non-streaming body with an OpenAI error object is converted to an Anthropic error", async () => {
  const res = await nonStreamingDispatchWithBody({ error: { message: "model not found", type: "invalid_request_error" } });
  assert.equal(res.status, 502);
  const json = await res.json();
  assert.equal(json.type, "error");
  assert.match(json.error.message, /model not found/);
});

test("non-streaming body with empty choices is converted to an Anthropic error", async () => {
  const res = await nonStreamingDispatchWithBody({ id: "x", choices: [] });
  assert.equal(res.status, 502);
  const json = await res.json();
  assert.match(json.error.message, /no choices/i);
});
