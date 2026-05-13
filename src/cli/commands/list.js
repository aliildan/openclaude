import { loadConfig } from "../../router/config.js";
import { listLocalOllamaModels } from "../ollama.js";

export async function list() {
  const cfg = await loadConfig();
  const ollamaBase = cfg.providers?.["ollama-local"]?.baseUrl || "http://127.0.0.1:11434";
  const models = await listLocalOllamaModels(ollamaBase);

  console.log(`ollama at ${ollamaBase}`);
  if (models.length === 0) {
    console.log(`  (no models — run "ollama list" to verify; "ollama pull <name>" to install)`);
    return;
  }
  console.log(`  ${models.length} model(s) installed:`);
  console.log("");
  for (const m of models) {
    const sz = m.parameter_size ? ` · ${m.parameter_size}` : "";
    const fam = m.family ? ` · ${m.family}` : "";
    console.log(`  ${m.name}${sz}${fam}`);
    console.log(`    /model ollama-local:${m.name}`);
    console.log("");
  }
}
