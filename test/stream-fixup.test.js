import test from "node:test";
import assert from "node:assert/strict";
import { fixupAnthropicStream } from "../src/router/stream-fixup.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

function streamFromChunks(chunks) {
  const queue = [...chunks];
  return new ReadableStream({
    pull(controller) {
      if (queue.length === 0) controller.close();
      else controller.enqueue(typeof queue[0] === "string" ? enc.encode(queue.shift()) : queue.shift());
    },
  });
}

async function collect(stream) {
  const reader = stream.getReader();
  let out = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) return out;
    out += dec.decode(value, { stream: true });
  }
}

function evt(type, payload) {
  return `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
}

test("orphan text content_block_delta synthesizes a content_block_start", async () => {
  const input = [
    evt("message_start", { type: "message_start", message: { id: "m1", type: "message", role: "assistant", content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } }),
    // Ollama bug: delta arrives WITHOUT preceding content_block_start
    evt("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello" } }),
    evt("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: " world" } }),
    evt("message_stop", { type: "message_stop" }),
  ];
  const out = await collect(fixupAnthropicStream(streamFromChunks(input)));
  // The first delta should now be preceded by a synthesized start.
  const startIdx = out.indexOf('"type":"content_block_start"');
  const firstDeltaIdx = out.indexOf('"text":"Hello"');
  assert.ok(startIdx !== -1, "expected synthesized content_block_start in output");
  assert.ok(startIdx < firstDeltaIdx, "synthesized start must precede the first delta");
  // The second delta must NOT trigger another synthesis (block 0 is now open).
  const startCount = out.split('"type":"content_block_start"').length - 1;
  assert.equal(startCount, 1, `expected exactly one synthesized start, got ${startCount}`);
});

test("well-formed stream passes through unchanged", async () => {
  const input =
    evt("message_start", { type: "message_start", message: { id: "m1" } }) +
    evt("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
    evt("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } }) +
    evt("content_block_stop", { type: "content_block_stop", index: 0 }) +
    evt("message_stop", { type: "message_stop" });
  const out = await collect(fixupAnthropicStream(streamFromChunks([input])));
  assert.equal(out, input, "well-formed input must round-trip exactly");
});

test("multiple content blocks: orphan delta on a new index synthesizes its own start", async () => {
  const input = [
    evt("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    evt("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "first" } }),
    evt("content_block_stop", { type: "content_block_stop", index: 0 }),
    // Now block 1 arrives orphan
    evt("content_block_delta", { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "second" } }),
  ];
  const out = await collect(fixupAnthropicStream(streamFromChunks(input)));
  const startCount = out.split('"type":"content_block_start"').length - 1;
  assert.equal(startCount, 2, "expected one explicit + one synthesized start");
  // The synthesized start must mention index 1
  assert.ok(out.includes('"index":1,"content_block":{"type":"text"'), "synth start must carry index 1");
});

test("input_json_delta orphan synthesizes a tool_use start with placeholder id", async () => {
  const input = [
    evt("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"a":1}' } }),
  ];
  const out = await collect(fixupAnthropicStream(streamFromChunks(input)));
  assert.ok(out.includes('"type":"tool_use"'), "expected synthesized tool_use block");
  assert.ok(out.includes('toolu_synth_0'), "expected placeholder tool_use id");
});

test("chunk boundary mid-event is buffered correctly", async () => {
  // Split a single event across two upstream chunks
  const e = evt("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } });
  const split = Math.floor(e.length / 2);
  const out = await collect(fixupAnthropicStream(streamFromChunks([e.slice(0, split), e.slice(split)])));
  assert.ok(out.includes('"type":"content_block_start"'), "synth start emitted across chunk boundary");
  assert.ok(out.includes('"text":"hi"'), "delta payload preserved across chunk boundary");
});

test("non-JSON data lines pass through untouched", async () => {
  const input = "event: ping\ndata: just-a-string\n\n";
  const out = await collect(fixupAnthropicStream(streamFromChunks([input])));
  assert.equal(out, input, "non-JSON SSE events must pass through unchanged");
});

test("orphan content_block_stop is dropped (was the smoking gun for kimi-k2.6)", async () => {
  const input = [
    evt("message_start", { type: "message_start", message: { id: "m1" } }),
    // Block 0 was never started, but Ollama emits a stop for it.
    evt("content_block_stop", { type: "content_block_stop", index: 0 }),
    evt("message_stop", { type: "message_stop" }),
  ];
  const out = await collect(fixupAnthropicStream(streamFromChunks(input)));
  assert.ok(!out.includes('"type":"content_block_stop"'), "orphan content_block_stop must be dropped");
  assert.ok(out.includes('"type":"message_start"'), "message_start must still be emitted");
  assert.ok(out.includes('"type":"message_stop"'), "message_stop must still be emitted");
});

test("chunk producing only dropped events still makes progress (hang regression)", { timeout: 5000 }, async () => {
  // The first chunk contains ONLY an event the fixer drops (orphan content_block_stop),
  // so it yields zero output. pull() must keep reading until it has something to
  // enqueue — the old code returned after a no-output chunk and the consumer hung
  // forever. The timeout turns a regression into a failure instead of a hang.
  const input = [
    evt("content_block_stop", { type: "content_block_stop", index: 0 }), // orphan → dropped, no output
    evt("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
      evt("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } }) +
      evt("content_block_stop", { type: "content_block_stop", index: 0 }) +
      evt("message_stop", { type: "message_stop" }),
  ];
  const out = await collect(fixupAnthropicStream(streamFromChunks(input)));
  const stopCount = out.split('"type":"content_block_stop"').length - 1;
  assert.equal(stopCount, 1, "orphan stop dropped; only the well-formed block's stop survives");
  assert.ok(out.includes('"text":"ok"'), "the real event after a dropped-only chunk is delivered");
  assert.ok(out.includes('"type":"message_stop"'), "stream completes without hanging");
});

test("message_stop with open blocks auto-closes them first", async () => {
  const input = [
    evt("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    evt("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } }),
    // No explicit content_block_stop — Ollama jumps straight to message_stop
    evt("message_stop", { type: "message_stop" }),
  ];
  const out = await collect(fixupAnthropicStream(streamFromChunks(input)));
  // The synthesized stop must appear BEFORE message_stop
  const stopIdx = out.indexOf('"type":"content_block_stop"');
  const msgStopIdx = out.indexOf('"type":"message_stop"');
  assert.ok(stopIdx !== -1, "expected synthesized content_block_stop");
  assert.ok(stopIdx < msgStopIdx, "synthesized stop must precede message_stop");
});
