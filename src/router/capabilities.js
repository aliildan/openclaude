// Probe Ollama model capabilities via /api/show, cached in-process.
//
// Why: Claude Code re-sends the full conversation history with every turn,
// including image content blocks from earlier turns. Routing that to a
// text-only model (deepseek-v4-pro:cloud, gpt-oss, etc.) returns 400
// "this model does not support image input". To keep history-rich sessions
// working, we strip image blocks before forwarding to text-only models.
//
// /api/show returns a `capabilities` array like ["completion","tools","vision","thinking"].
// We treat absence of "vision" as text-only.

const cache = new Map(); // key: `${baseUrl}|${name}` → {vision, tools, thinking}

// Only successful probes are cached. A 404 from a not-yet-running Ollama or a
// transient network blip would otherwise stick the optimistic "vision: true"
// fallback in the cache for the rest of the daemon's life — masking the real
// capabilities of the model forever after Ollama comes back. Caching only the
// happy path means failures are retried on the next dispatch.
export async function getCapabilities(baseUrl, modelName) {
  const key = `${baseUrl}|${modelName}`;
  if (cache.has(key)) return cache.get(key);
  try {
    const res = await fetch(new URL("/api/show", baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: modelName }),
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) {
      // Endpoint not available (e.g. ollama-cloud direct) — assume vision so we
      // don't strip silently. If the model rejects images, the upstream error
      // surfaces to the user clearly. Not cached: re-probe next request.
      return { vision: true, tools: true, thinking: true, source: "fallback" };
    }
    const json = await res.json();
    const caps = new Set(Array.isArray(json.capabilities) ? json.capabilities : []);
    const result = {
      vision: caps.has("vision"),
      tools: caps.has("tools"),
      thinking: caps.has("thinking"),
      source: "probed",
    };
    cache.set(key, result);
    return result;
  } catch {
    // Network error / timeout — same logic as the !res.ok branch: don't cache.
    return { vision: true, tools: true, thinking: true, source: "error" };
  }
}

// Strip image content blocks (and any other unsupported types) from the
// request body when the target model lacks the capability. Replaces stripped
// blocks with a brief text marker so the model gets some signal that
// something was elided.
export function stripUnsupportedContent(body, capabilities) {
  if (!Array.isArray(body?.messages)) return { body, stripped: 0 };
  if (capabilities.vision) return { body, stripped: 0 };

  let stripped = 0;
  const newMessages = body.messages.map((m) => {
    if (!Array.isArray(m.content)) return m;
    const newContent = [];
    for (const c of m.content) {
      if (c?.type === "image") {
        stripped++;
        newContent.push({ type: "text", text: "[image omitted: current model is text-only]" });
      } else if (c?.type === "tool_result" && Array.isArray(c.content)) {
        // tool_result.content can contain nested image blocks
        const inner = [];
        let nestedStripped = false;
        for (const ic of c.content) {
          if (ic?.type === "image") {
            stripped++;
            nestedStripped = true;
            inner.push({ type: "text", text: "[image omitted: current model is text-only]" });
          } else {
            inner.push(ic);
          }
        }
        newContent.push(nestedStripped ? { ...c, content: inner } : c);
      } else {
        newContent.push(c);
      }
    }
    return { ...m, content: newContent };
  });

  return { body: { ...body, messages: newMessages }, stripped };
}
