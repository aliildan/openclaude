const encoder = new TextEncoder();

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function textFromAnthropicContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("");
}

function openAIUserPart(block) {
  if (!block || typeof block !== "object") return null;
  if (block.type === "text" && typeof block.text === "string") {
    return { type: "text", text: block.text };
  }
  if (block.type === "image") {
    const source = block.source ?? {};
    if (source.type === "base64" && source.media_type && source.data) {
      return {
        type: "image_url",
        image_url: { url: `data:${source.media_type};base64,${source.data}` },
      };
    }
    if (source.type === "url" && typeof source.url === "string") {
      return { type: "image_url", image_url: { url: source.url } };
    }
    return { type: "text", text: "[unsupported image omitted]" };
  }
  if (block.type === "document") {
    return { type: "text", text: "[document omitted by OpenAI-compatible adapter]" };
  }
  return null;
}

function asOpenAIUserContent(blocks) {
  const parts = blocks.map(openAIUserPart).filter(Boolean);
  if (parts.length === 0) return "";
  if (parts.every((p) => p.type === "text")) {
    return parts.map((p) => p.text).join("");
  }
  return parts;
}

function toolResultText(block) {
  const content = block?.content;
  let text;
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .map((part) => {
        if (part?.type === "text") return part.text ?? "";
        if (part?.type === "image") return "[image in tool result omitted]";
        return "";
      })
      .filter(Boolean)
      .join("\n");
  } else if (content == null) {
    text = "";
  } else {
    text = JSON.stringify(content);
  }
  return block?.is_error ? `[tool error]\n${text}` : text;
}

function normalizeToolId(id, fallbackIndex = 0) {
  const raw = typeof id === "string" && id ? id : `call_oc_${fallbackIndex}`;
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120);
  return cleaned || `call_oc_${fallbackIndex}`;
}

function convertUserMessage(message) {
  if (typeof message.content === "string") {
    return [{ role: "user", content: message.content }];
  }
  const blocks = Array.isArray(message.content) ? message.content : [];
  const toolResults = blocks.filter((b) => b?.type === "tool_result");
  const normalBlocks = blocks.filter((b) => b?.type !== "tool_result");
  const out = [];

  // OpenAI requires tool-result messages to directly correspond to prior
  // assistant.tool_calls. Emit them first, then any ordinary user content.
  for (const block of toolResults) {
    out.push({
      role: "tool",
      tool_call_id: normalizeToolId(block.tool_use_id),
      content: toolResultText(block),
    });
  }
  if (normalBlocks.length > 0) {
    out.push({ role: "user", content: asOpenAIUserContent(normalBlocks) });
  }
  if (out.length === 0) out.push({ role: "user", content: "" });
  return out;
}

function convertAssistantMessage(message) {
  if (typeof message.content === "string") {
    return [{ role: "assistant", content: message.content }];
  }
  const blocks = Array.isArray(message.content) ? message.content : [];
  let content = "";
  const toolCalls = [];

  for (const block of blocks) {
    if (block?.type === "text" && typeof block.text === "string") {
      content += block.text;
      continue;
    }
    if (block?.type === "tool_use") {
      const idx = toolCalls.length;
      toolCalls.push({
        id: normalizeToolId(block.id, idx),
        type: "function",
        function: {
          name: typeof block.name === "string" && block.name ? block.name : "unknown",
          arguments: JSON.stringify(isObject(block.input) || Array.isArray(block.input) ? block.input : {}),
        },
      });
    }
    // thinking/redacted_thinking are intentionally dropped. Replaying unsigned
    // provider reasoning as Anthropic thinking blocks creates signature failures.
  }

  const out = { role: "assistant", content: content || null };
  if (toolCalls.length > 0) out.tool_calls = toolCalls;
  if (out.content === null && toolCalls.length === 0) out.content = "";
  return [out];
}

function convertMessages(messages) {
  const out = [];
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message?.role === "assistant") out.push(...convertAssistantMessage(message));
    else out.push(...convertUserMessage(message ?? {}));
  }
  return out;
}

function convertSystem(system) {
  if (typeof system === "string") return system;
  if (!Array.isArray(system)) return "";
  return system
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
}

function convertTools(tools) {
  if (!Array.isArray(tools)) return undefined;
  return tools
    .filter((tool) => tool && typeof tool.name === "string")
    .map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        ...(typeof tool.description === "string" ? { description: tool.description } : {}),
        parameters: isObject(tool.input_schema) ? tool.input_schema : { type: "object", properties: {} },
      },
    }));
}

function convertToolChoice(choice) {
  if (!choice) return {};
  if (typeof choice === "string") return { tool_choice: choice };
  const result = {};
  switch (choice.type) {
    case "auto": result.tool_choice = "auto"; break;
    case "any": result.tool_choice = "required"; break;
    case "none": result.tool_choice = "none"; break;
    case "tool":
      if (choice.name) result.tool_choice = { type: "function", function: { name: choice.name } };
      break;
    default: break;
  }
  if (choice.disable_parallel_tool_use === true) result.parallel_tool_calls = false;
  return result;
}

export function anthropicToOpenAIRequest(body, modelId, provider = {}) {
  const messages = [];
  const system = convertSystem(body?.system);
  if (system) messages.push({ role: "system", content: system });
  messages.push(...convertMessages(body?.messages));

  const out = {
    model: modelId,
    messages,
    stream: body?.stream !== false,
  };

  if (Number.isFinite(body?.max_tokens)) out.max_tokens = body.max_tokens;
  if (Number.isFinite(body?.temperature)) out.temperature = body.temperature;
  if (Number.isFinite(body?.top_p)) out.top_p = body.top_p;
  if (Array.isArray(body?.stop_sequences) && body.stop_sequences.length > 0) out.stop = body.stop_sequences;

  const tools = convertTools(body?.tools);
  if (tools?.length) out.tools = tools;
  Object.assign(out, convertToolChoice(body?.tool_choice));

  // Request usage in the final streaming chunk when supported. Gateways that
  // ignore stream_options are still valid OpenAI-compatible endpoints.
  if (out.stream) out.stream_options = { include_usage: true };

  // Explicit operator-supplied defaults are useful for provider quirks. These
  // are merged last, except model/messages which must stay router-controlled.
  if (isObject(provider.requestDefaults)) {
    Object.assign(out, provider.requestDefaults);
    out.model = modelId;
    out.messages = messages;
  }

  // Do not forward Anthropic `thinking`/signatures. Agnes can reason internally,
  // but exposing non-Anthropic reasoning as signed Anthropic blocks is unsafe.
  delete out.thinking;
  return out;
}

function estimateStringTokens(text) {
  let ascii = 0;
  let nonAscii = 0;
  for (const ch of String(text ?? "")) {
    if (ch.codePointAt(0) <= 0x7f) ascii += 1;
    else nonAscii += 1;
  }
  return Math.ceil(ascii / 4 + nonAscii * 1.1);
}

export function estimateAnthropicInputTokens(body) {
  let total = 0;
  total += estimateStringTokens(convertSystem(body?.system));
  total += estimateStringTokens(JSON.stringify(body?.messages ?? []));
  total += estimateStringTokens(JSON.stringify(body?.tools ?? []));
  total += 8 * (Array.isArray(body?.messages) ? body.messages.length : 0);
  return Math.max(1, Math.ceil(total));
}

function mapStopReason(finishReason, hasTools) {
  if (hasTools || finishReason === "tool_calls" || finishReason === "function_call") return "tool_use";
  if (finishReason === "length") return "max_tokens";
  return "end_turn";
}

function parseArguments(raw) {
  if (typeof raw !== "string" || raw.trim() === "") return {};
  try {
    const parsed = JSON.parse(raw);
    return isObject(parsed) || Array.isArray(parsed) ? parsed : { value: parsed };
  } catch {
    return { _raw_arguments: raw };
  }
}

function usageFromOpenAI(usage) {
  return {
    input_tokens: Number(usage?.prompt_tokens ?? usage?.input_tokens ?? 0) || 0,
    output_tokens: Number(usage?.completion_tokens ?? usage?.output_tokens ?? 0) || 0,
  };
}

export function openAIJsonToAnthropic(json, fallbackModel = "unknown") {
  const choice = json?.choices?.[0] ?? {};
  const msg = choice.message ?? {};
  const content = [];
  if (typeof msg.content === "string" && msg.content.length > 0) {
    content.push({ type: "text", text: msg.content });
  }
  const toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
  toolCalls.forEach((tc, idx) => {
    content.push({
      type: "tool_use",
      id: normalizeToolId(tc?.id, idx),
      name: tc?.function?.name || "unknown",
      input: parseArguments(tc?.function?.arguments),
    });
  });
  if (content.length === 0) content.push({ type: "text", text: "" });

  return {
    id: typeof json?.id === "string" ? json.id : `msg_oc_${Date.now()}`,
    type: "message",
    role: "assistant",
    model: json?.model || fallbackModel,
    content,
    stop_reason: mapStopReason(choice.finish_reason, toolCalls.length > 0),
    stop_sequence: null,
    usage: usageFromOpenAI(json?.usage),
  };
}

function sseEvent(type, payload) {
  return `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function getDataPayload(rawEvent) {
  const lines = rawEvent.replace(/\r\n/g, "\n").split("\n");
  const data = [];
  for (const line of lines) {
    if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  return data.length ? data.join("\n") : null;
}

function appendFragment(current, fragment) {
  if (typeof fragment !== "string" || fragment.length === 0) return current;
  if (!current) return fragment;
  // Some OpenAI-compatible gateways repeat id/name in every chunk.
  if (fragment === current || current.endsWith(fragment)) return current;
  if (fragment.startsWith(current)) return fragment;
  return current + fragment;
}

export function openAIStreamToAnthropic(upstream, { model = "unknown" } = {}) {
  const reader = upstream.getReader();
  const decoder = new TextDecoder();
  let cancelled = false;

  return new ReadableStream({
    async start(controller) {
      let buffer = "";
      let messageStarted = false;
      let messageId = `msg_oc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      let responseModel = model;
      let nextBlockIndex = 0;
      let textIndex = null;
      let textOpen = false;
      let sawTool = false;
      let postToolText = "";
      let finishReason = null;
      let usage = null;
      let toolOrder = 0;
      const tools = new Map();

      const emit = (text) => controller.enqueue(encoder.encode(text));
      const ensureMessageStart = (chunk = {}) => {
        if (messageStarted) return;
        if (typeof chunk.id === "string" && chunk.id) messageId = chunk.id;
        if (typeof chunk.model === "string" && chunk.model) responseModel = chunk.model;
        emit(sseEvent("message_start", {
          type: "message_start",
          message: {
            id: messageId,
            type: "message",
            role: "assistant",
            model: responseModel,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        }));
        messageStarted = true;
      };
      const openText = () => {
        if (textOpen) return;
        textIndex = nextBlockIndex++;
        emit(sseEvent("content_block_start", {
          type: "content_block_start",
          index: textIndex,
          content_block: { type: "text", text: "" },
        }));
        textOpen = true;
      };
      const closeText = () => {
        if (!textOpen) return;
        emit(sseEvent("content_block_stop", { type: "content_block_stop", index: textIndex }));
        textOpen = false;
        textIndex = null;
      };
      const addToolFragment = (tc, fallbackIndex = 0) => {
        const openAIIndex = Number.isInteger(tc?.index) ? tc.index : fallbackIndex;
        let state = tools.get(openAIIndex);
        if (!state) {
          state = { openAIIndex, order: toolOrder++, id: "", name: "", args: "" };
          tools.set(openAIIndex, state);
        }
        state.id = appendFragment(state.id, tc?.id);
        state.name = appendFragment(state.name, tc?.function?.name);
        state.args = appendFragment(state.args, tc?.function?.arguments);
      };

      const processChunk = (chunk) => {
        ensureMessageStart(chunk);
        if (chunk?.usage) usage = chunk.usage;
        const choices = Array.isArray(chunk?.choices) ? chunk.choices : [];
        for (const choice of choices) {
          if (choice?.finish_reason) finishReason = choice.finish_reason;
          const delta = choice?.delta ?? {};

          const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
          if (toolCalls.length > 0 || delta.function_call) {
            if (!sawTool) {
              sawTool = true;
              closeText();
            }
            toolCalls.forEach((tc, i) => addToolFragment(tc, i));
            if (delta.function_call) {
              addToolFragment({
                index: 0,
                id: "call_legacy_0",
                function: delta.function_call,
              }, 0);
            }
          }

          if (typeof delta.content === "string" && delta.content.length > 0) {
            if (sawTool) {
              postToolText += delta.content;
            } else {
              openText();
              emit(sseEvent("content_block_delta", {
                type: "content_block_delta",
                index: textIndex,
                delta: { type: "text_delta", text: delta.content },
              }));
            }
          }
          // Deliberately ignore provider-specific reasoning_content/reasoning.
        }
      };

      const flushToolsAndFinish = () => {
        ensureMessageStart();
        closeText();

        const ordered = [...tools.values()].sort((a, b) => a.order - b.order);
        for (let i = 0; i < ordered.length; i++) {
          const tool = ordered[i];
          const index = nextBlockIndex++;
          const id = normalizeToolId(tool.id, i);
          const name = tool.name || "unknown";
          let args = tool.args?.trim() || "{}";
          // Anthropic expects JSON fragments. Preserve valid JSON exactly; for a
          // malformed upstream payload, produce valid JSON so Claude Code's
          // parser survives and the tool receives the raw string for diagnosis.
          try { JSON.parse(args); } catch { args = JSON.stringify({ _raw_arguments: args }); }

          emit(sseEvent("content_block_start", {
            type: "content_block_start",
            index,
            content_block: { type: "tool_use", id, name, input: {} },
          }));
          emit(sseEvent("content_block_delta", {
            type: "content_block_delta",
            index,
            delta: { type: "input_json_delta", partial_json: args },
          }));
          emit(sseEvent("content_block_stop", { type: "content_block_stop", index }));
        }

        if (postToolText) {
          const index = nextBlockIndex++;
          emit(sseEvent("content_block_start", {
            type: "content_block_start",
            index,
            content_block: { type: "text", text: "" },
          }));
          emit(sseEvent("content_block_delta", {
            type: "content_block_delta",
            index,
            delta: { type: "text_delta", text: postToolText },
          }));
          emit(sseEvent("content_block_stop", { type: "content_block_stop", index }));
        }

        const u = usageFromOpenAI(usage);
        emit(sseEvent("message_delta", {
          type: "message_delta",
          delta: {
            stop_reason: mapStopReason(finishReason, ordered.length > 0),
            stop_sequence: null,
          },
          usage: { output_tokens: u.output_tokens },
        }));
        emit(sseEvent("message_stop", { type: "message_stop" }));
      };

      try {
        while (!cancelled) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
          while (true) {
            const end = buffer.indexOf("\n\n");
            if (end === -1) break;
            const rawEvent = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const data = getDataPayload(rawEvent);
            if (data == null || data === "") continue;
            if (data === "[DONE]") {
              buffer = "";
              break;
            }
            let chunk;
            try { chunk = JSON.parse(data); } catch { continue; }
            processChunk(chunk);
          }
        }
        if (buffer.trim()) {
          const data = getDataPayload(buffer);
          if (data && data !== "[DONE]") {
            try { processChunk(JSON.parse(data)); } catch { /* ignore trailing junk */ }
          }
        }
        flushToolsAndFinish();
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    },
    async cancel(reason) {
      cancelled = true;
      try { await reader.cancel(reason); } catch {}
    },
  });
}

export function anthropicMessageToSse(message) {
  const parts = [];
  parts.push(sseEvent("message_start", {
    type: "message_start",
    message: {
      ...message,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: message?.usage?.input_tokens ?? 0, output_tokens: 0 },
    },
  }));

  let index = 0;
  for (const block of message?.content ?? []) {
    if (block.type === "text") {
      parts.push(sseEvent("content_block_start", {
        type: "content_block_start", index, content_block: { type: "text", text: "" },
      }));
      if (block.text) parts.push(sseEvent("content_block_delta", {
        type: "content_block_delta", index, delta: { type: "text_delta", text: block.text },
      }));
      parts.push(sseEvent("content_block_stop", { type: "content_block_stop", index }));
    } else if (block.type === "tool_use") {
      parts.push(sseEvent("content_block_start", {
        type: "content_block_start",
        index,
        content_block: { type: "tool_use", id: block.id, name: block.name, input: {} },
      }));
      parts.push(sseEvent("content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input ?? {}) },
      }));
      parts.push(sseEvent("content_block_stop", { type: "content_block_stop", index }));
    }
    index += 1;
  }
  parts.push(sseEvent("message_delta", {
    type: "message_delta",
    delta: { stop_reason: message?.stop_reason ?? "end_turn", stop_sequence: null },
    usage: { output_tokens: message?.usage?.output_tokens ?? 0 },
  }));
  parts.push(sseEvent("message_stop", { type: "message_stop" }));
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  });
}

export function openAIErrorToAnthropic(status, jsonOrText) {
  const message = typeof jsonOrText === "string"
    ? jsonOrText
    : jsonOrText?.error?.message ?? jsonOrText?.message ?? `Upstream returned HTTP ${status}`;
  let type = "api_error";
  if (status === 400 || status === 404 || status === 422) type = "invalid_request_error";
  else if (status === 401) type = "authentication_error";
  else if (status === 403) type = "permission_error";
  else if (status === 429) type = "rate_limit_error";
  else if (status >= 500) type = "api_error";
  return { type: "error", error: { type, message } };
}
