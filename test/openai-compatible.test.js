import test from "node:test";
import assert from "node:assert/strict";
import {
  anthropicToOpenAIRequest,
  estimateAnthropicInputTokens,
  openAIJsonToAnthropic,
  openAIStreamToAnthropic,
} from "../src/router/openai-compat.js";

function streamFromText(text, splitAt = []) {
  const encoder = new TextEncoder();
  const points = [0, ...splitAt.filter((n) => n > 0 && n < text.length), text.length].sort((a, b) => a - b);
  return new ReadableStream({
    start(controller) {
      for (let i = 0; i < points.length - 1; i++) {
        controller.enqueue(encoder.encode(text.slice(points[i], points[i + 1])));
      }
      controller.close();
    },
  });
}

async function readStream(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

function parseAnthropicSSE(text) {
  return text.split("\n\n").filter(Boolean).map((raw) => {
    const event = raw.split("\n").find((l) => l.startsWith("event:"))?.slice(6).trim();
    const data = raw.split("\n").find((l) => l.startsWith("data:"))?.slice(5).trim();
    return { event, data: data ? JSON.parse(data) : null };
  });
}

test("converts Anthropic tools and tool results to OpenAI chat format", () => {
  const request = anthropicToOpenAIRequest({
    model: "ignored",
    stream: true,
    max_tokens: 2048,
    system: [{ type: "text", text: "system one" }, { type: "text", text: "system two" }],
    tools: [{ name: "Bash", description: "run", input_schema: { type: "object", properties: { command: { type: "string" } } } }],
    tool_choice: { type: "auto", disable_parallel_tool_use: true },
    messages: [
      { role: "assistant", content: [
        { type: "text", text: "I will run it." },
        { type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "pwd" } },
      ] },
      { role: "user", content: [
        { type: "tool_result", tool_use_id: "toolu_1", content: "C:/work" },
        { type: "text", text: "continue" },
      ] },
    ],
  }, "agnes-2.5-flash");

  assert.equal(request.model, "agnes-2.5-flash");
  assert.equal(request.messages[0].role, "system");
  assert.equal(request.messages[1].tool_calls[0].function.name, "Bash");
  assert.equal(request.messages[2].role, "tool");
  assert.equal(request.messages[2].tool_call_id, "toolu_1");
  assert.equal(request.messages[3].role, "user");
  assert.equal(request.parallel_tool_calls, false);
  assert.equal(request.tools[0].function.parameters.properties.command.type, "string");
});

test("converts Anthropic base64 image to OpenAI image_url", () => {
  const request = anthropicToOpenAIRequest({
    messages: [{ role: "user", content: [
      { type: "text", text: "inspect" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
    ] }],
  }, "agnes-2.5-flash");
  assert.ok(Array.isArray(request.messages[0].content));
  assert.equal(request.messages[0].content[1].image_url.url, "data:image/png;base64,AAAA");
});

test("converts non-streaming OpenAI tool call response", () => {
  const result = openAIJsonToAnthropic({
    id: "chatcmpl_1",
    model: "agnes-2.5-flash",
    choices: [{
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_1", type: "function", function: { name: "Read", arguments: "{\"file_path\":\"a.txt\"}" } }],
      },
    }],
    usage: { prompt_tokens: 10, completion_tokens: 4 },
  });
  assert.equal(result.stop_reason, "tool_use");
  assert.equal(result.content[0].type, "tool_use");
  assert.deepEqual(result.content[0].input, { file_path: "a.txt" });
  assert.equal(result.usage.input_tokens, 10);
});

test("stream state machine buffers parallel tool calls and emits valid Anthropic blocks", async () => {
  const chunks = [
    { id: "chat_1", model: "agnes-2.5-flash", choices: [{ delta: { role: "assistant", content: "Checking..." }, finish_reason: null }] },
    { choices: [{ delta: { tool_calls: [
      { index: 0, id: "call_a", type: "function", function: { name: "Bash", arguments: "{\"command\":" } },
      { index: 1, id: "call_b", type: "function", function: { name: "Read", arguments: "{\"file_path\":" } },
    ] }, finish_reason: null }] },
    { choices: [{ delta: { tool_calls: [
      { index: 1, function: { arguments: "\"README.md\"}" } },
      { index: 0, function: { arguments: "\"pwd\"}" } },
    ] }, finish_reason: null }] },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 100, completion_tokens: 20 } },
  ];
  const sse = chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
  const out = await readStream(openAIStreamToAnthropic(streamFromText(sse, [7, 61, 137, 280]), { model: "agnes-2.5-flash" }));
  const events = parseAnthropicSSE(out);

  assert.equal(events[0].event, "message_start");
  assert.equal(events.at(-1).event, "message_stop");

  const starts = events.filter((e) => e.event === "content_block_start");
  const stops = events.filter((e) => e.event === "content_block_stop");
  assert.equal(starts.length, 3); // one text + two tools
  assert.equal(stops.length, 3);

  const toolStarts = starts.filter((e) => e.data.content_block.type === "tool_use");
  assert.deepEqual(toolStarts.map((e) => e.data.content_block.name), ["Bash", "Read"]);

  const toolDeltas = events.filter((e) => e.data?.delta?.type === "input_json_delta");
  assert.equal(toolDeltas[0].data.delta.partial_json, '{"command":"pwd"}');
  assert.equal(toolDeltas[1].data.delta.partial_json, '{"file_path":"README.md"}');

  const opened = new Set();
  for (const event of events) {
    if (event.event === "content_block_start") opened.add(event.data.index);
    if (event.event === "content_block_delta") assert.ok(opened.has(event.data.index), `orphan delta for ${event.data.index}`);
    if (event.event === "content_block_stop") {
      assert.ok(opened.has(event.data.index), `orphan stop for ${event.data.index}`);
      opened.delete(event.data.index);
    }
  }
  assert.equal(opened.size, 0);
});

test("malformed tool JSON is wrapped as valid JSON instead of breaking Claude parser", async () => {
  const sse = [
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_x", function: { name: "Bash", arguments: "{bad" } }] }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\n`,
    "data: [DONE]\n\n",
  ].join("");
  const out = await readStream(openAIStreamToAnthropic(streamFromText(sse), { model: "agnes" }));
  const events = parseAnthropicSSE(out);
  const delta = events.find((e) => e.data?.delta?.type === "input_json_delta").data.delta.partial_json;
  assert.deepEqual(JSON.parse(delta), { _raw_arguments: "{bad" });
});

test("token estimate is positive and accounts for CJK", () => {
  const a = estimateAnthropicInputTokens({ messages: [{ role: "user", content: "hello" }] });
  const b = estimateAnthropicInputTokens({ messages: [{ role: "user", content: "这是一段中文测试文本" }] });
  assert.ok(a > 0);
  assert.ok(b > a);
});
