// Unconditional request-body sanitizers — applied to every outgoing message,
// regardless of provider. These fix dirty data the *previous* upstream may
// have left in the conversation history, which would otherwise cause the
// *next* upstream to reject the whole turn.

// Anthropic's API requires tool_use.id to match ^[a-zA-Z0-9_-]+$.
// Ollama's compat layer can emit ids containing colons / dots / slashes,
// which Claude Code stores in the session history and replays. When the user
// later switches back to a Claude model, Anthropic rejects the request with
// "messages.N.content.M.tool_use.id: String should match pattern ...".
//
// We rewrite each dirty id to a deterministic clean form AND remap any
// matching tool_result.tool_use_id so the result block still references the
// right tool call.

const TOOL_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

export function sanitizeToolIds(body) {
  if (!Array.isArray(body?.messages)) return { body, fixed: 0 };

  const idMap = new Map(); // dirty → clean
  function ensureClean(id) {
    if (typeof id !== "string") return null;
    if (TOOL_ID_PATTERN.test(id)) return id;
    if (idMap.has(id)) return idMap.get(id);
    const cleaned = "toolu_oc_" + id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
    idMap.set(id, cleaned);
    return cleaned;
  }

  // First pass: collect every tool_use.id that needs cleaning.
  for (const m of body.messages) {
    if (!Array.isArray(m?.content)) continue;
    for (const c of m.content) {
      if (c?.type === "tool_use") ensureClean(c.id);
    }
  }
  if (idMap.size === 0) return { body, fixed: 0 };

  // Second pass: rewrite tool_use.id AND tool_result.tool_use_id.
  const newMessages = body.messages.map((m) => {
    if (!Array.isArray(m?.content)) return m;
    const newContent = m.content.map((c) => {
      if (c?.type === "tool_use" && idMap.has(c.id)) {
        return { ...c, id: idMap.get(c.id) };
      }
      if (c?.type === "tool_result" && idMap.has(c.tool_use_id)) {
        return { ...c, tool_use_id: idMap.get(c.tool_use_id) };
      }
      return c;
    });
    return { ...m, content: newContent };
  });

  return { body: { ...body, messages: newMessages }, fixed: idMap.size };
}

// Anthropic cryptographically signs every `thinking` content block it emits;
// the signature is validated when the block is replayed in a follow-up turn.
// Non-Anthropic upstreams (Ollama, our own stream-fixup synthesizer) emit
// thinking blocks with empty or placeholder signatures, which Anthropic then
// rejects on the next turn with: "Invalid `signature` in `thinking` block".
//
// Strategy: real Anthropic signatures are long opaque base64-ish strings
// (typically > 100 chars). Anything shorter/empty is treated as fake and the
// thinking block is replaced with a plain-text marker so the model still
// sees that something happened, just not the unverifiable content.
const ANTHROPIC_SIG_MIN_LENGTH = 64;

export function sanitizeThinkingBlocks(body) {
  if (!Array.isArray(body?.messages)) return { body, fixed: 0 };
  let fixed = 0;
  const newMessages = body.messages.map((m) => {
    if (!Array.isArray(m?.content)) return m;
    const newContent = m.content.map((c) => {
      if (c?.type !== "thinking") return c;
      const sig = typeof c.signature === "string" ? c.signature : "";
      if (sig.length >= ANTHROPIC_SIG_MIN_LENGTH) return c; // looks legit, keep
      fixed++;
      return { type: "text", text: "[thinking from a prior model omitted]" };
    });
    return { ...m, content: newContent };
  });
  return { body: fixed > 0 ? { ...body, messages: newMessages } : body, fixed };
}

