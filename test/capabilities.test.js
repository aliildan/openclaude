import test from "node:test";
import assert from "node:assert/strict";
import { stripUnsupportedContent } from "../src/router/capabilities.js";

test("stripUnsupportedContent: text-only model strips image blocks", () => {
  const body = {
    messages: [
      { role: "user", content: [
        { type: "text", text: "look at this" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } },
      ]},
    ],
  };
  const { body: out, stripped } = stripUnsupportedContent(body, { vision: false });
  assert.equal(stripped, 1);
  assert.equal(out.messages[0].content.length, 2);
  assert.equal(out.messages[0].content[0].type, "text");
  assert.equal(out.messages[0].content[0].text, "look at this");
  assert.equal(out.messages[0].content[1].type, "text");
  assert.match(out.messages[0].content[1].text, /image omitted/);
});

test("stripUnsupportedContent: vision-capable model leaves images alone", () => {
  const body = {
    messages: [
      { role: "user", content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } },
      ]},
    ],
  };
  const { body: out, stripped } = stripUnsupportedContent(body, { vision: true });
  assert.equal(stripped, 0);
  assert.equal(out, body, "should return identical reference when nothing stripped");
});

test("stripUnsupportedContent: nested images inside tool_result are stripped", () => {
  const body = {
    messages: [
      { role: "user", content: [
        { type: "tool_result", tool_use_id: "t1", content: [
          { type: "text", text: "screenshot taken" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "abc" } },
        ]},
      ]},
    ],
  };
  const { body: out, stripped } = stripUnsupportedContent(body, { vision: false });
  assert.equal(stripped, 1);
  const tr = out.messages[0].content[0];
  assert.equal(tr.type, "tool_result");
  assert.equal(tr.content[1].type, "text");
  assert.match(tr.content[1].text, /image omitted/);
});

test("stripUnsupportedContent: string content (no array) passes through", () => {
  const body = {
    messages: [{ role: "user", content: "plain string" }],
  };
  const { body: out, stripped } = stripUnsupportedContent(body, { vision: false });
  assert.equal(stripped, 0);
  assert.equal(out.messages[0].content, "plain string");
});

test("stripUnsupportedContent: multiple turns, multiple images", () => {
  const body = {
    messages: [
      { role: "user", content: [{ type: "image", source: {} }, { type: "text", text: "1" }] },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      { role: "user", content: [{ type: "image", source: {} }, { type: "text", text: "2" }] },
    ],
  };
  const { stripped } = stripUnsupportedContent(body, { vision: false });
  assert.equal(stripped, 2);
});

test("stripUnsupportedContent: missing/malformed body returns zero stripped", () => {
  const { stripped } = stripUnsupportedContent({}, { vision: false });
  assert.equal(stripped, 0);
  const r2 = stripUnsupportedContent({ messages: null }, { vision: false });
  assert.equal(r2.stripped, 0);
});
