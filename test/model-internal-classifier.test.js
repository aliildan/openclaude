import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveInternalClassifierModel } from "../src/cli/commands/model-internal-classifier.js";

// --- resolveInternalClassifierModel tests ---

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

test("resolveInternalClassifierModel: null/undefined returns null envValue", () => {
  const result = resolveInternalClassifierModel(null, ollamaModels, baseCfg);
  assert.deepEqual(result, { envValue: null, warning: null });
  const result2 = resolveInternalClassifierModel(undefined, ollamaModels, baseCfg);
  assert.deepEqual(result2, { envValue: null, warning: null });
});

test("resolveInternalClassifierModel: installed ollama-local model passes through", () => {
  const result = resolveInternalClassifierModel("ollama-local:qwen2.5-coder:7b", ollamaModels, baseCfg);
  assert.equal(result.envValue, "ollama-local:qwen2.5-coder:7b");
  assert.equal(result.warning, null);
});

test("resolveInternalClassifierModel: uninstalled ollama-local model returns warning", () => {
  const result = resolveInternalClassifierModel("ollama-local:gemma4:31b", ollamaModels, baseCfg);
  assert.equal(result.envValue, null);
  assert.ok(result.warning.includes("gemma4:31b"), "warning should mention the missing model");
  assert.ok(result.warning.includes("Haiku"), "warning should mention Haiku fallback");
});

test("resolveInternalClassifierModel: Anthropic model ID passes through regardless", () => {
  const result = resolveInternalClassifierModel("claude-haiku-4-5-20251001", ollamaModels, baseCfg);
  assert.equal(result.envValue, "claude-haiku-4-5-20251001");
  assert.equal(result.warning, null);
});

test("resolveInternalClassifierModel: empty string returns null envValue", () => {
  const result = resolveInternalClassifierModel("", ollamaModels, baseCfg);
  assert.deepEqual(result, { envValue: null, warning: null });
});

// --- Config round-trip tests ---

test("saveConfig + loadConfig round-trip preserves internalClassifierModel", async () => {
  const home = join(tmpdir(), `oc-test-classifier-${Date.now()}`);
  await mkdir(home, { recursive: true });
  try {
    const origHome = process.env.OPENCLAUDE_HOME;
    process.env.OPENCLAUDE_HOME = home;

    const { loadConfig: freshLoad, saveConfig: freshSave } = await import("../src/router/config.js?" + Date.now());
    const cfg = await freshLoad();
    cfg.internalClassifierModel = "ollama-local:qwen2.5-coder:7b";
    await freshSave(cfg);

    const reloaded = await freshLoad();
    assert.equal(reloaded.internalClassifierModel, "ollama-local:qwen2.5-coder:7b");

    process.env.OPENCLAUDE_HOME = origHome;
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("removing internalClassifierModel key from config", async () => {
  const home = join(tmpdir(), `oc-test-classifier-del-${Date.now()}`);
  await mkdir(home, { recursive: true });
  try {
    const origHome = process.env.OPENCLAUDE_HOME;
    process.env.OPENCLAUDE_HOME = home;

    const { loadConfig: freshLoad, saveConfig: freshSave } = await import("../src/router/config.js?" + Date.now());

    let cfg = await freshLoad();
    cfg.internalClassifierModel = "ollama-local:llama3:8b";
    await freshSave(cfg);

    cfg = await freshLoad();
    assert.equal(cfg.internalClassifierModel, "ollama-local:llama3:8b");

    const { internalClassifierModel: _, ...rest } = cfg;
    await freshSave(rest);

    const reloaded = await freshLoad();
    assert.equal(reloaded.internalClassifierModel, undefined);

    process.env.OPENCLAUDE_HOME = origHome;
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
