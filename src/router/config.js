import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_DIR = process.env.OPENCLAUDE_HOME || join(homedir(), ".openclaude");
const DEFAULT_FILE = join(DEFAULT_DIR, "config.json");

const DEFAULT_CONFIG = {
  port: 11436,
  defaultProvider: "claude",
  providers: {
    claude: {
      type: "anthropic-passthrough",
      baseUrl: "https://api.anthropic.com",
    },
    "ollama-local": {
      type: "ollama",
      baseUrl: "http://127.0.0.1:11434",
    },
    "ollama-cloud": {
      type: "ollama",
      baseUrl: "https://ollama.com",
      apiKey: "$OLLAMA_API_KEY",
    },
  },
};

export const paths = { dir: DEFAULT_DIR, file: DEFAULT_FILE };

export async function ensureConfig() {
  try {
    await stat(DEFAULT_FILE);
  } catch {
    await mkdir(DEFAULT_DIR, { recursive: true });
    await writeFile(DEFAULT_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n");
  }
  return DEFAULT_FILE;
}

export async function loadConfig() {
  await ensureConfig();
  const raw = await readFile(DEFAULT_FILE, "utf8");
  const cfg = JSON.parse(raw);
  return { ...DEFAULT_CONFIG, ...cfg, providers: { ...DEFAULT_CONFIG.providers, ...(cfg.providers ?? {}) } };
}

export function interpolateEnv(value) {
  if (typeof value !== "string") return value;
  return value.replace(/\$([A-Z_][A-Z0-9_]*)/g, (_, name) => process.env[name] ?? "");
}

// Parse a model identifier into { providerId, modelId }.
// Supports:
//   "ollama-local:gemma4:31b-cloud" → { providerId: "ollama-local", modelId: "gemma4:31b-cloud" }
//   "claude:sonnet"                 → { providerId: "claude",       modelId: "sonnet" }
//   "sonnet" / "claude-opus-4-7"    → { providerId: <default>,      modelId: "sonnet" }
// Provider matching is greedy: longest configured provider name that prefixes
// the model wins, so "ollama-local" beats "ollama" if both exist.
export function parseModelTarget(model, cfg) {
  const providers = Object.keys(cfg.providers ?? {});
  // explicit provider:model — match longest provider name first
  const sorted = [...providers].sort((a, b) => b.length - a.length);
  for (const p of sorted) {
    if (model.startsWith(p + ":")) {
      return { providerId: p, modelId: model.slice(p.length + 1) };
    }
  }
  // no provider prefix — use default (typically "claude")
  return { providerId: cfg.defaultProvider ?? "claude", modelId: model };
}
