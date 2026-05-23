import test from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSubagentModel } from "../src/cli/commands/model-subagent.js";
import { loadConfig, saveConfig } from "../src/router/config.js";

// --- resolveSubagentModel tests ---

const baseCfg = {
  defaultProvider: "claude",
  providers: {
    claude: { type: "anthropic-passthrough", baseUrl: "https://api.anthropic.com" },
    "ollama-local": { type: "ollama", baseUrl: "http://127.0.0.1:11434" },
  },
};

const ollamaModels = [
  { name: "qwen2.5-coder:7b", size: 4700000000, family: "qwen2", parameter_size: "7B" },
  { name: "llama3:8b", size: 4900000000, family: "llama", parameter_size: "8B" },
];

test("resolveSubagentModel: null/undefined returns null envValue", () => {
  const result = resolveSubagentModel(null, ollamaModels, baseCfg);
  assert.deepEqual(result, { envValue: null, warning: null });
  const result2 = resolveSubagentModel(undefined, ollamaModels, baseCfg);
  assert.deepEqual(result2, { envValue: null, warning: null });
});

test("resolveSubagentModel: installed ollama-local model passes through", () => {
  const result = resolveSubagentModel("ollama-local:qwen2.5-coder:7b", ollamaModels, baseCfg);
  assert.equal(result.envValue, "ollama-local:qwen2.5-coder:7b");
  assert.equal(result.warning, null);
});

test("resolveSubagentModel: uninstalled ollama-local model returns warning", () => {
  const result = resolveSubagentModel("ollama-local:gemma4:31b", ollamaModels, baseCfg);
  assert.equal(result.envValue, null);
  assert.ok(result.warning.includes("gemma4:31b"), "warning should mention the missing model");
});

test("resolveSubagentModel: Anthropic model ID passes through regardless", () => {
  const result = resolveSubagentModel("claude-haiku-4-5-20251001", ollamaModels, baseCfg);
  assert.equal(result.envValue, "claude-haiku-4-5-20251001");
  assert.equal(result.warning, null);
});

test("resolveSubagentModel: empty string returns null envValue", () => {
  const result = resolveSubagentModel("", ollamaModels, baseCfg);
  assert.deepEqual(result, { envValue: null, warning: null });
});

// --- Config round-trip tests ---

test("saveConfig + loadConfig round-trip preserves subagentModel", async () => {
  const home = join(tmpdir(), `oc-test-subagent-${Date.now()}`);
  await mkdir(home, { recursive: true });
  try {
    const origHome = process.env.OPENCLAUDE_HOME;
    process.env.OPENCLAUDE_HOME = home;

    // Re-import config module to pick up the new OPENCLAUDE_HOME
    const { loadConfig: freshLoad, saveConfig: freshSave } = await import("../src/router/config.js");
    const cfg = await freshLoad();
    cfg.subagentModel = "ollama-local:qwen2.5-coder:7b";
    await freshSave(cfg);

    const reloaded = await freshLoad();
    assert.equal(reloaded.subagentModel, "ollama-local:qwen2.5-coder:7b");

    process.env.OPENCLAUDE_HOME = origHome;
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("removing subagentModel key from config", async () => {
  const home = join(tmpdir(), `oc-test-subagent-del-${Date.now()}`);
  await mkdir(home, { recursive: true });
  try {
    const origHome = process.env.OPENCLAUDE_HOME;
    process.env.OPENCLAUDE_HOME = home;

    const { loadConfig: freshLoad, saveConfig: freshSave } = await import("../src/router/config.js");

    // Set a subagentModel
    let cfg = await freshLoad();
    cfg.subagentModel = "ollama-local:llama3:8b";
    await freshSave(cfg);

    // Verify it's there
    cfg = await freshLoad();
    assert.equal(cfg.subagentModel, "ollama-local:llama3:8b");

    // Remove the key
    const { subagentModel: _, ...rest } = cfg;
    await freshSave(rest);

    // Verify it's gone
    const reloaded = await freshLoad();
    assert.equal(reloaded.subagentModel, undefined);

    process.env.OPENCLAUDE_HOME = origHome;
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
