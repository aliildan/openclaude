import test from "node:test";
import assert from "node:assert/strict";
import { sanitizeToolIds, sanitizeThinkingBlocks } from "../src/router/sanitize.js";

test("sanitizeToolIds: clean ids pass through unchanged", () => {
  const body = {
    messages: [
      { role: "assistant", content: [
        { type: "tool_use", id: "toolu_abc123", name: "read", input: {} },
      ]},
      { role: "user", content: [
        { type: "tool_result", tool_use_id: "toolu_abc123", content: "ok" },
      ]},
    ],
  };
  const { fixed, body: out } = sanitizeToolIds(body);
  assert.equal(fixed, 0);
  assert.equal(out, body, "should return identical reference when nothing fixed");
});

test("sanitizeToolIds: dirty ids with dots/colons are rewritten on both sides", () => {
  const body = {
    messages: [
      { role: "assistant", content: [
        { type: "text", text: "calling tool" },
        { type: "tool_use", id: "tool_call.read#0:abc", name: "read", input: {} },
      ]},
      { role: "user", content: [
        { type: "tool_result", tool_use_id: "tool_call.read#0:abc", content: "result" },
      ]},
    ],
  };
  const { fixed, body: out } = sanitizeToolIds(body);
  assert.equal(fixed, 1);
  const useId = out.messages[0].content[1].id;
  const resultRef = out.messages[1].content[0].tool_use_id;
  assert.match(useId, /^[a-zA-Z0-9_-]+$/, "tool_use.id must match Anthropic regex after sanitization");
  assert.equal(useId, resultRef, "tool_result.tool_use_id must reference the SAME cleaned id");
  assert.ok(useId.startsWith("toolu_oc_"), "cleaned id should be marked with toolu_oc_ prefix");
});

test("sanitizeToolIds: multiple dirty ids get distinct clean ids when content differs", () => {
  const body = {
    messages: [
      { role: "assistant", content: [
        { type: "tool_use", id: "tool.read#0", name: "read", input: {} },
        { type: "tool_use", id: "tool.write#1", name: "write", input: {} },
      ]},
    ],
  };
  const { fixed, body: out } = sanitizeToolIds(body);
  assert.equal(fixed, 2);
  const id1 = out.messages[0].content[0].id;
  const id2 = out.messages[0].content[1].id;
  assert.notEqual(id1, id2, "distinct dirty ids must remain distinct after cleaning");
});

test("sanitizeToolIds: same dirty id used in multiple turns gets the same clean id", () => {
  const dirty = "tool.read#0";
  const body = {
    messages: [
      { role: "assistant", content: [{ type: "tool_use", id: dirty, name: "read", input: {} }] },
      { role: "user",      content: [{ type: "tool_result", tool_use_id: dirty, content: "ok" }] },
      { role: "assistant", content: [{ type: "text", text: "got it" }] },
    ],
  };
  const { body: out } = sanitizeToolIds(body);
  const cleanA = out.messages[0].content[0].id;
  const cleanB = out.messages[1].content[0].tool_use_id;
  assert.equal(cleanA, cleanB);
});

test("sanitizeToolIds: messages without arrays / no tool_use leave body untouched", () => {
  const body = { messages: [{ role: "user", content: "plain text turn" }] };
  const { fixed, body: out } = sanitizeToolIds(body);
  assert.equal(fixed, 0);
  assert.equal(out, body);
});

test("sanitizeToolIds: long dirty id gets truncated", () => {
  const dirty = "tool." + "x".repeat(200) + "#0";
  const body = {
    messages: [{ role: "assistant", content: [{ type: "tool_use", id: dirty, name: "x", input: {} }] }],
  };
  const { body: out } = sanitizeToolIds(body);
  const clean = out.messages[0].content[0].id;
  assert.ok(clean.length <= 80, "cleaned id must not be excessively long");
  assert.match(clean, /^[a-zA-Z0-9_-]+$/);
});

// ---- thinking block sanitization ----

test("sanitizeThinkingBlocks: empty signature is dropped (replaced with text marker)", () => {
  const body = {
    messages: [
      { role: "assistant", content: [
        { type: "thinking", thinking: "I should think...", signature: "" },
        { type: "text", text: "Here's my answer" },
      ]},
    ],
  };
  const { fixed, body: out } = sanitizeThinkingBlocks(body);
  assert.equal(fixed, 1);
  assert.equal(out.messages[0].content[0].type, "text");
  assert.match(out.messages[0].content[0].text, /thinking.*omitted/i);
  assert.equal(out.messages[0].content[1].text, "Here's my answer", "non-thinking blocks untouched");
});

test("sanitizeThinkingBlocks: short signature is dropped", () => {
  const body = {
    messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "x", signature: "fake_sig" }] }],
  };
  const { fixed } = sanitizeThinkingBlocks(body);
  assert.equal(fixed, 1, "short non-Anthropic signature should be dropped");
});

test("sanitizeThinkingBlocks: long base64-like signature is preserved (real Anthropic)", () => {
  const realSig = "EuYBC".repeat(40); // 200 chars, looks like a real signature
  const body = {
    messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "real", signature: realSig }] }],
  };
  const { fixed, body: out } = sanitizeThinkingBlocks(body);
  assert.equal(fixed, 0);
  assert.equal(out, body);
  assert.equal(out.messages[0].content[0].signature, realSig);
});

test("sanitizeThinkingBlocks: missing signature field treated as empty (dropped)", () => {
  const body = {
    messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "no sig" }] }],
  };
  const { fixed } = sanitizeThinkingBlocks(body);
  assert.equal(fixed, 1);
});

test("sanitizeThinkingBlocks: no thinking blocks → identity passthrough", () => {
  const body = { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] };
  const { fixed, body: out } = sanitizeThinkingBlocks(body);
  assert.equal(fixed, 0);
  assert.equal(out, body);
});
