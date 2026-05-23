import { spawn } from "node:child_process";
import { writeFile, mkdir, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { ensureDaemonRunning } from "../daemon.js";
import { loadConfig, interpolateEnv, parseModelTarget, paths } from "../../router/config.js";
import { listLocalOllamaModels } from "../ollama.js";
import { SENTINEL_AUTH_TOKEN, readOauthAccessToken } from "../../router/auth.js";
import { resolveSubagentModel } from "./model-subagent.js";
import { resolveInternalClassifierModel } from "./model-internal-classifier.js";

// Friendly natural ID for the env-var alias slots (Custom/Sonnet/Opus). Claude
// Code does not validate these strings, so the readable form survives intact
// in `/model` output and chat displays.
function ollamaPickerId(modelName) {
  return `ollama-local:${modelName}`;
}

export async function start(args) {
  const status = await ensureDaemonRunning();
  const cfg = await loadConfig();

  // Clear stale active-file state from previously crashed sessions before
  // computing this session's values. `oc stop` also unlinks these, but a
  // crashed `oc start` leaves them behind — clean here too.
  await unlink(join(paths.dir, "subagent-active")).catch(() => {});
  await unlink(join(paths.dir, "internal-classifier-active")).catch(() => {});

  const ollamaBase = cfg.providers?.["ollama-local"]?.baseUrl || "http://127.0.0.1:11434";
  const ollamaModels = await listLocalOllamaModels(ollamaBase);

  console.error(`[openclaude] router on http://127.0.0.1:${status.port}`);
  if (ollamaModels.length === 0) {
    console.error(`[openclaude] no Ollama models detected at ${ollamaBase}.`);
    console.error(`[openclaude] start ollama and "ollama pull <model>" first; then "oc start" again.`);
  } else {
    console.error(`[openclaude] found ${ollamaModels.length} Ollama model(s):`);
    for (const m of ollamaModels) console.error(`  - ${m.name}`);
  }

  // Strip openclaude-specific flags before passing the rest to claude.
  const enableDiscovery = !args.includes("--no-discovery");
  const aggressive = args.includes("--bridge=aggressive") || process.env.OPENCLAUDE_BRIDGE === "aggressive";
  const passthroughArgs = args.filter((a) =>
    a !== "--no-discovery" &&
    a !== "--bridge=aggressive" &&
    a !== "--bridge=conservative"
  );

  // ⚠️ ANTHROPIC_DEFAULT_HAIKU_MODEL is used for Claude Code's safety classifier
  // and other background tasks. The default is Anthropic Haiku (via subscription),
  // but users can override it with `oc internal-classifier` to route those requests
  // to a local/cloud Ollama model instead — useful when Anthropic subscription
  // limits are exhausted or when running fully offline.
  //
  // Conservative (default): only the singular Custom slot → 1 Ollama model in picker.
  // Aggressive (--bridge=aggressive): also Sonnet + Opus → 3 Ollama models in picker.
  //
  // Discovery mode: setting ANTHROPIC_AUTH_TOKEN to our sentinel makes Claude
  // Code think it's in third-party-API-key mode → triggers gateway model
  // discovery (GET /v1/models) → our router enumerates ALL Ollama models.
  // Inference requests then carry the sentinel as the Authorization header;
  // the anthropic-passthrough provider swaps it for the real OAuth bearer
  // pulled from ~/.claude/.credentials.json before forwarding to Anthropic.
  // Pass --no-discovery to skip this and stay in pure-OAuth mode (only the
  // env-var-bound slots will appear in the picker, no auto-discovery).
  const oauthOk = await readOauthAccessToken();
  if (enableDiscovery && !oauthOk) {
    console.error(`[openclaude] WARNING: discovery mode requested but no OAuth token at ~/.claude/.credentials.json`);
    console.error(`[openclaude]          inference will fail. Run "claude" once and log in, then "oc start" again,`);
    console.error(`[openclaude]          or pass --no-discovery to skip auth substitution.`);
  }

  // Warn about providers whose apiKey template can't be resolved. Without this,
  // a missing env var manifests as a silent 401 retry loop inside Claude Code.
  for (const [pid, p] of Object.entries(cfg.providers ?? {})) {
    if (p.type !== "ollama" || !p.apiKey) continue;
    if (interpolateEnv(p.apiKey)) continue;
    const missing = p.apiKey.match(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/)?.[1];
    console.error(`[openclaude] WARNING: provider "${pid}" needs ${missing ? `env var ${missing}` : `apiKey "${p.apiKey}"`} — currently unset.`);
    console.error(`[openclaude]          its models will be hidden from /model and any direct call returns 401.`);
  }

  const env = { ...process.env, ANTHROPIC_BASE_URL: `http://127.0.0.1:${status.port}` };
  if (enableDiscovery) {
    env.ANTHROPIC_AUTH_TOKEN = SENTINEL_AUTH_TOKEN;
    env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY = "1";
  }
  const bindings = [];

  function bindAlias(prefix, slotName, m) {
    env[`${prefix}_MODEL`] = ollamaPickerId(m.name);
    env[`${prefix}_MODEL_NAME`] = `${m.name} (Ollama)`;
    env[`${prefix}_MODEL_DESCRIPTION`] = describe(m);
    bindings.push({ slot: slotName, name: m.name });
  }

  let i = 0;
  if (aggressive && ollamaModels[i]) bindAlias("ANTHROPIC_DEFAULT_SONNET", "Sonnet", ollamaModels[i++]);
  if (aggressive && ollamaModels[i]) bindAlias("ANTHROPIC_DEFAULT_OPUS",   "Opus",   ollamaModels[i++]);
  if (ollamaModels[i]) {
    const m = ollamaModels[i++];
    env.ANTHROPIC_CUSTOM_MODEL_OPTION = ollamaPickerId(m.name);
    env.ANTHROPIC_CUSTOM_MODEL_OPTION_NAME = `${m.name} (Ollama)`;
    env.ANTHROPIC_CUSTOM_MODEL_OPTION_DESCRIPTION = describe(m);
    bindings.push({ slot: "(Custom)", name: m.name });
  }

  console.error(`[openclaude] mode: ${aggressive ? "aggressive" : "conservative (safe)"} · discovery: ${enableDiscovery ? "ON (all Ollama models in /model)" : "OFF (alias slots only)"}`);

  // Subagent model: if configured, validate and set CLAUDE_CODE_SUBAGENT_MODEL.
  // This env var is read once when claude starts, so the choice only takes
  // effect at start time — exactly like the other env-var bindings above.
  const subResolved = resolveSubagentModel(cfg.subagentModel, ollamaModels, cfg);
  if (subResolved.warning) {
    console.error(`[openclaude] WARNING: ${subResolved.warning}`);
  }
  if (subResolved.envValue) {
    env.CLAUDE_CODE_SUBAGENT_MODEL = subResolved.envValue;
  }
  const subagentLabel = env.CLAUDE_CODE_SUBAGENT_MODEL ?? "default (Anthropic)";
  console.error(`[openclaude] subagent model: ${subagentLabel}`);
  await writeFile(join(paths.dir, "subagent-active"), env.CLAUDE_CODE_SUBAGENT_MODEL || "");

  // Internal-classifier model: override Haiku (used for safety classification
  // and other background tasks) with an Ollama model when configured.
  const classifierResolved = resolveInternalClassifierModel(cfg.internalClassifierModel, ollamaModels, cfg);
  if (classifierResolved.warning) {
    console.error(`[openclaude] WARNING: ${classifierResolved.warning}`);
  }
  if (classifierResolved.envValue) {
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = classifierResolved.envValue;
  }
  const classifierLabel = env.ANTHROPIC_DEFAULT_HAIKU_MODEL ?? "default (Anthropic Haiku)";
  console.error(`[openclaude] internal-classifier model: ${classifierLabel}`);
  await writeFile(join(paths.dir, "internal-classifier-active"), env.ANTHROPIC_DEFAULT_HAIKU_MODEL || "");
  if (enableDiscovery) {
    console.error(`[openclaude] note: ANTHROPIC_AUTH_TOKEN is set to a sentinel; Remote Control / /schedule / claude.ai MCP connectors / notification preferences will be disabled this session (subscription inference still works).`);
  }
  if (bindings.length > 0) {
    console.error(`[openclaude] /model picker bindings (friendly names):`);
    for (const b of bindings) console.error(`  ${b.slot.padEnd(8)} → ${b.name}`);
    console.error(`  ${aggressive ? "Default + Sonnet[1m] + Haiku" : "Default + Sonnet + Opus + Haiku"} → real Anthropic via your subscription`);
  }
  if (ollamaModels.length > i) {
    console.error(`[openclaude] ${ollamaModels.length - i} more Ollama model(s) — paste into /model to use:`);
    for (const m of ollamaModels.slice(i)) {
      console.error(`         /model ${ollamaPickerId(m.name)}`);
    }
    if (!aggressive) console.error(`[openclaude] tip: --bridge=aggressive exposes 2 more via Sonnet+Opus slots.`);
  }
  console.error(`[openclaude] launching: claude ${passthroughArgs.join(" ")}`);

  await ensureModelSubagentCommand();
  await ensureModelInternalClassifierCommand();

  const child = spawn("claude", passthroughArgs, { stdio: "inherit", env });
  child.on("exit", (code) => process.exit(code ?? 0));
  child.on("error", (err) => {
    console.error(`[openclaude] failed to exec "claude": ${err.message}`);
    console.error(`[openclaude] is Claude Code installed and on your PATH?`);
    process.exit(127);
  });
}

// Command files that make /model-subagent and /model-internal-classifier available
// inside Claude Code sessions. Written to ~/.claude/commands/ once per user so
// they work in every project. Never rewritten — users can edit or delete freely.
const SUBAGENT_COMMAND = "Run `oc model-subagent` in bash and show the full output to the user. Do not ask any questions.";
const CLASSIFIER_COMMAND = "Run `oc internal-classifier` in bash and show the full output to the user. Do not ask any questions.";

async function ensureCommandFileIfMissing(name, content) {
  const dir = join(homedir(), ".claude", "commands");
  await mkdir(dir, { recursive: true });
  const path = join(dir, name);
  try {
    await stat(path);
    return; // exists — never touch
  } catch {
    await writeFile(path, content);
  }
}

async function ensureModelSubagentCommand() {
  await ensureCommandFileIfMissing("model-subagent.md", SUBAGENT_COMMAND);
}

async function ensureModelInternalClassifierCommand() {
  await ensureCommandFileIfMissing("model-internal-classifier.md", CLASSIFIER_COMMAND);
}

function describe(m) {
  return `Local Ollama · ${m.parameter_size ?? ""} ${m.family ?? ""}`.trim();
}
