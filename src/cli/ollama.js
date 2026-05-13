// Detect installed Ollama models by hitting the local Ollama API.
// Falls back gracefully if Ollama isn't running.

export async function listLocalOllamaModels(baseUrl = "http://127.0.0.1:11434") {
  try {
    const res = await fetch(new URL("/api/tags", baseUrl), { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return [];
    const json = await res.json();
    const models = Array.isArray(json?.models) ? json.models : [];
    return models.map((m) => ({
      name: m.name,                                      // e.g. "qwen2.5-coder:7b"
      size: m.size,
      family: m.details?.family,
      parameter_size: m.details?.parameter_size,
    }));
  } catch {
    return [];
  }
}
