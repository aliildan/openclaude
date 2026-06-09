import test from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Tests that need the file-fallback path set OPENCLAUDE_DISABLE_KEYCHAIN=1
// so the macOS Keychain (which on dev machines has a live Claude Code login)
// doesn't shadow the file lookup. Without this, file-fallback tests are
// silently bypassed on macOS and the assertions become meaningless.

// --- readOauthAccessToken: env var priority ---

test("readOauthAccessToken: returns OPENCLAUDE_OAUTH_TOKEN env var when set", async () => {
  const origEnv = process.env.OPENCLAUDE_OAUTH_TOKEN;
  process.env.OPENCLAUDE_OAUTH_TOKEN = "test-token-from-env";
  try {
    const { readOauthAccessToken } = await import("../src/router/auth.js");
    const token = await readOauthAccessToken();
    assert.equal(token, "test-token-from-env");
  } finally {
    process.env.OPENCLAUDE_OAUTH_TOKEN = origEnv;
  }
});

test("readOauthAccessToken: env var takes priority over credentials file", async () => {
  const origEnv = process.env.OPENCLAUDE_OAUTH_TOKEN;
  process.env.OPENCLAUDE_OAUTH_TOKEN = "env-token-priority";
  try {
    const { readOauthAccessToken } = await import("../src/router/auth.js");
    const token = await readOauthAccessToken();
    assert.equal(token, "env-token-priority");
  } finally {
    process.env.OPENCLAUDE_OAUTH_TOKEN = origEnv;
  }
});

test("readOauthAccessToken: env var takes priority over keychain", async () => {
  const origEnv = process.env.OPENCLAUDE_OAUTH_TOKEN;
  process.env.OPENCLAUDE_OAUTH_TOKEN = "env-overrides-keychain";
  try {
    const { readOauthAccessToken } = await import("../src/router/auth.js");
    const token = await readOauthAccessToken();
    assert.equal(token, "env-overrides-keychain");
  } finally {
    process.env.OPENCLAUDE_OAUTH_TOKEN = origEnv;
  }
});

// --- isTokenExpired ---

test("isTokenExpired: returns false for undefined/null expiresAt", async () => {
  const { isTokenExpired } = await import("../src/router/auth.js");
  assert.equal(isTokenExpired(undefined), false);
  assert.equal(isTokenExpired(null), false);
});

test("isTokenExpired: returns true for past timestamps (milliseconds)", async () => {
  const { isTokenExpired } = await import("../src/router/auth.js");
  assert.equal(isTokenExpired(Date.now() - 1000), true);
});

test("isTokenExpired: returns true for past timestamps (seconds)", async () => {
  const { isTokenExpired } = await import("../src/router/auth.js");
  assert.equal(isTokenExpired(Math.floor(Date.now() / 1000) - 10), true);
});

test("isTokenExpired: returns false for future timestamps", async () => {
  const { isTokenExpired } = await import("../src/router/auth.js");
  assert.equal(isTokenExpired(Date.now() + 3600000), false);
});

// --- readKeychainToken ---

test("readKeychainToken: returns null when OPENCLAUDE_DISABLE_KEYCHAIN is set", async () => {
  const orig = process.env.OPENCLAUDE_DISABLE_KEYCHAIN;
  process.env.OPENCLAUDE_DISABLE_KEYCHAIN = "1";
  try {
    const { readKeychainToken } = await import("../src/router/auth.js");
    const result = await readKeychainToken();
    assert.equal(result, null);
  } finally {
    process.env.OPENCLAUDE_DISABLE_KEYCHAIN = orig;
  }
});

// --- credentials file fallback (keychain disabled) ---

test("readOauthAccessToken: returns null when env, keychain, and file all empty", async () => {
  const origEnv = process.env.OPENCLAUDE_OAUTH_TOKEN;
  const origKeychain = process.env.OPENCLAUDE_DISABLE_KEYCHAIN;
  const origHome = process.env.HOME;
  delete process.env.OPENCLAUDE_OAUTH_TOKEN;
  process.env.OPENCLAUDE_DISABLE_KEYCHAIN = "1";
  const home = join(tmpdir(), `oc-test-auth-empty-${Date.now()}`);
  await mkdir(home, { recursive: true });
  try {
    process.env.HOME = home;
    const { readOauthAccessToken } = await import("../src/router/auth.js?" + Date.now());
    const token = await readOauthAccessToken();
    assert.equal(token, null);
  } finally {
    process.env.OPENCLAUDE_OAUTH_TOKEN = origEnv;
    process.env.OPENCLAUDE_DISABLE_KEYCHAIN = origKeychain;
    process.env.HOME = origHome;
    await rm(home, { recursive: true, force: true });
  }
});

test("readOauthAccessToken: credentials file with expired token returns null", async () => {
  const origEnv = process.env.OPENCLAUDE_OAUTH_TOKEN;
  const origKeychain = process.env.OPENCLAUDE_DISABLE_KEYCHAIN;
  const origHome = process.env.HOME;
  delete process.env.OPENCLAUDE_OAUTH_TOKEN;
  process.env.OPENCLAUDE_DISABLE_KEYCHAIN = "1";
  const home = join(tmpdir(), `oc-test-auth-expired-${Date.now()}`);
  await mkdir(home, { recursive: true });
  const claudeDir = join(home, ".claude");
  await mkdir(claudeDir, { recursive: true });
  const credsFile = join(claudeDir, ".credentials.json");
  await writeFile(credsFile, JSON.stringify({
    claudeAiOauth: {
      accessToken: "sk-ant-expired-token",
      expiresAt: Date.now() - 10000,
    },
  }));
  try {
    process.env.HOME = home;
    const { readOauthAccessToken } = await import("../src/router/auth.js?" + Date.now());
    const token = await readOauthAccessToken();
    assert.equal(token, null);
  } finally {
    process.env.OPENCLAUDE_OAUTH_TOKEN = origEnv;
    process.env.OPENCLAUDE_DISABLE_KEYCHAIN = origKeychain;
    process.env.HOME = origHome;
    await rm(home, { recursive: true, force: true });
  }
});

test("readOauthAccessToken: credentials file with valid (non-expired) token is returned", async () => {
  const origEnv = process.env.OPENCLAUDE_OAUTH_TOKEN;
  const origKeychain = process.env.OPENCLAUDE_DISABLE_KEYCHAIN;
  const origHome = process.env.HOME;
  delete process.env.OPENCLAUDE_OAUTH_TOKEN;
  process.env.OPENCLAUDE_DISABLE_KEYCHAIN = "1";
  const home = join(tmpdir(), `oc-test-auth-valid-${Date.now()}`);
  await mkdir(home, { recursive: true });
  const claudeDir = join(home, ".claude");
  await mkdir(claudeDir, { recursive: true });
  const credsFile = join(claudeDir, ".credentials.json");
  await writeFile(credsFile, JSON.stringify({
    claudeAiOauth: {
      accessToken: "sk-ant-valid-token",
      expiresAt: Date.now() + 3600000,
    },
  }));
  try {
    process.env.HOME = home;
    const { readOauthAccessToken } = await import("../src/router/auth.js?" + Date.now());
    const token = await readOauthAccessToken();
    assert.equal(token, "sk-ant-valid-token");
  } finally {
    process.env.OPENCLAUDE_OAUTH_TOKEN = origEnv;
    process.env.OPENCLAUDE_DISABLE_KEYCHAIN = origKeychain;
    process.env.HOME = origHome;
    await rm(home, { recursive: true, force: true });
  }
});
