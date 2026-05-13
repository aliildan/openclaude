import test from "node:test";
import assert from "node:assert/strict";
import { parseModelTarget } from "../src/router/config.js";

const cfg = {
  defaultProvider: "claude",
  providers: {
    claude: { type: "anthropic-passthrough", baseUrl: "https://api.anthropic.com" },
    "ollama-local": { type: "ollama", baseUrl: "http://127.0.0.1:11434" },
    "ollama-cloud": { type: "ollama", baseUrl: "https://ollama.com" },
  },
};

test("explicit provider:model splits correctly", () => {
  assert.deepEqual(parseModelTarget("ollama-local:gemma4:31b-cloud", cfg), {
    providerId: "ollama-local",
    modelId: "gemma4:31b-cloud",
  });
});

test("longest provider name wins (ollama-local beats nothing here, but also no shorter conflict)", () => {
  assert.deepEqual(parseModelTarget("ollama-cloud:qwen3-coder", cfg), {
    providerId: "ollama-cloud",
    modelId: "qwen3-coder",
  });
});

test("bare alias falls through to default provider", () => {
  assert.deepEqual(parseModelTarget("sonnet", cfg), {
    providerId: "claude",
    modelId: "sonnet",
  });
});

test("full model id with no prefix falls through to default provider", () => {
  assert.deepEqual(parseModelTarget("claude-opus-4-7", cfg), {
    providerId: "claude",
    modelId: "claude-opus-4-7",
  });
});

test("claude:sonnet — explicit claude provider", () => {
  assert.deepEqual(parseModelTarget("claude:sonnet", cfg), {
    providerId: "claude",
    modelId: "sonnet",
  });
});

test("model with multiple colons preserves them in modelId", () => {
  assert.deepEqual(parseModelTarget("ollama-local:qwen2.5:7b", cfg), {
    providerId: "ollama-local",
    modelId: "qwen2.5:7b",
  });
});

test("custom defaultProvider is honored", () => {
  const cfg2 = { ...cfg, defaultProvider: "ollama-local" };
  assert.deepEqual(parseModelTarget("llama3", cfg2), {
    providerId: "ollama-local",
    modelId: "llama3",
  });
});
