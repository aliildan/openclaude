// SSE stream sanitizer for Ollama's Anthropic-compatibility layer.
//
// The bug it fixes: Ollama sometimes emits a `content_block_delta` or
// `content_block_stop` for an index that was never opened with a preceding
// `content_block_start`. Claude Code then aborts with "Content block not found".
//
// What this transform does:
//   - Tracks which content-block indices have been opened.
//   - Orphan `content_block_delta` → synthesizes a matching `content_block_start`
//     (text / thinking / tool_use) and emits it before the delta.
//   - Orphan `content_block_stop` → drops the stop entirely (or synthesizes a
//     start+stop pair if we'd otherwise lose the slot).
//   - Tracks message_start / message_stop so we don't drop the message frame.
//   - Passes everything else through unchanged byte-for-byte.
//
// Set OPENCLAUDE_DEBUG_STREAM=1 to dump every raw upstream event AND every
// rewritten output event to ~/.openclaude/stream-debug.log for diagnosis.

import { appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const ENCODER = new TextEncoder();
const DECODER_OPTS = { stream: true };
const DEBUG = process.env.OPENCLAUDE_DEBUG_STREAM === "1";
const DEBUG_FILE = join(homedir(), ".openclaude", "stream-debug.log");

function debugDump(tag, text) {
  if (!DEBUG) return;
  try { appendFileSync(DEBUG_FILE, `\n=== ${tag} @ ${new Date().toISOString()} ===\n${text}\n`); } catch {}
}

export function fixupAnthropicStream(upstream) {
  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const openBlocks = new Set();

  return new ReadableStream({
    async pull(controller) {
      const { value, done } = await reader.read();
      if (done) {
        if (buffer) controller.enqueue(ENCODER.encode(buffer));
        controller.close();
        return;
      }
      const chunkText = decoder.decode(value, DECODER_OPTS);
      debugDump("upstream-chunk", chunkText);
      buffer += chunkText;

      let cursor = 0;
      while (true) {
        const end = buffer.indexOf("\n\n", cursor);
        if (end === -1) break;
        const rawEvent = buffer.slice(cursor, end);
        const out = processEvent(rawEvent, openBlocks);
        if (out !== rawEvent) debugDump("rewrote-event", `IN:\n${rawEvent}\n---OUT:\n${out}`);
        // Empty output means "drop this event" (e.g. orphan content_block_stop).
        if (out !== "") controller.enqueue(ENCODER.encode(out + "\n\n"));
        cursor = end + 2;
      }
      buffer = buffer.slice(cursor);
    },
    cancel(reason) { return reader.cancel(reason); },
  });
}

function processEvent(rawEvent, openBlocks) {
  // SSE event format: one or more "field: value" lines separated by \n,
  // event ended by blank line. We only care about the "data:" line(s).
  const lines = rawEvent.split("\n");
  let dataPayload = null;
  for (const line of lines) {
    if (line.startsWith("data: ")) {
      dataPayload = line.slice(6);
      break; // Anthropic SSE puts the JSON in a single line
    } else if (line.startsWith("data:")) {
      dataPayload = line.slice(5).trimStart();
      break;
    }
  }
  if (dataPayload === null) return rawEvent;

  let payload;
  try { payload = JSON.parse(dataPayload); } catch { return rawEvent; }

  if (payload && typeof payload === "object") {
    if (payload.type === "content_block_start" && Number.isInteger(payload.index)) {
      openBlocks.add(payload.index);
      return rawEvent;
    }

    if (payload.type === "content_block_stop" && Number.isInteger(payload.index)) {
      if (!openBlocks.has(payload.index)) {
        // Orphan stop. Drop it — emitting a stop for a never-started block
        // is exactly what makes Claude Code throw "Content block not found".
        return "";
      }
      openBlocks.delete(payload.index);
      return rawEvent;
    }

    if (payload.type === "content_block_delta" && Number.isInteger(payload.index) && !openBlocks.has(payload.index)) {
      const synthBlock = synthesizeBlockForDelta(payload);
      openBlocks.add(payload.index);
      const startPayload = {
        type: "content_block_start",
        index: payload.index,
        content_block: synthBlock,
      };
      const startEvent = `event: content_block_start\ndata: ${JSON.stringify(startPayload)}`;
      return `${startEvent}\n\n${rawEvent}`;
    }

    // message_delta / message_stop: ensure all open blocks are closed first,
    // otherwise Claude Code may complain about mid-flight blocks.
    if ((payload.type === "message_delta" || payload.type === "message_stop") && openBlocks.size > 0) {
      const stops = [];
      for (const idx of openBlocks) {
        stops.push(`event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: idx })}`);
      }
      openBlocks.clear();
      return `${stops.join("\n\n")}\n\n${rawEvent}`;
    }
  }
  return rawEvent;
}

function synthesizeBlockForDelta(deltaPayload) {
  const dt = deltaPayload?.delta?.type;
  if (dt === "text_delta") return { type: "text", text: "" };
  if (dt === "thinking_delta") return { type: "thinking", thinking: "" };
  if (dt === "signature_delta") return { type: "thinking", thinking: "", signature: "" };
  if (dt === "input_json_delta") {
    // For tool_use blocks, Anthropic's start event normally carries id+name.
    // We don't have those — synthesize stable placeholders. Downstream parsers
    // accept this; the response just appears as an unnamed tool call.
    return {
      type: "tool_use",
      id: `toolu_synth_${deltaPayload.index}`,
      name: "unknown",
      input: {},
    };
  }
  // Unknown delta type — default to a text block so the index exists.
  return { type: "text", text: "" };
}
