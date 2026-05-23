// Bridge between Claude Code's OAuth subscription auth and the gateway-discovery
// requirement that ANTHROPIC_AUTH_TOKEN be set.
//
// The flow:
//   1. `oc start` exports ANTHROPIC_AUTH_TOKEN = SENTINEL.
//   2. Claude Code sees that env, treats itself as third-party-API-key mode →
//      triggers gateway model discovery against our /v1/models endpoint.
//   3. Claude Code also sends every inference request with
//        Authorization: Bearer <SENTINEL>
//      Forwarding that to api.anthropic.com would 401, since the sentinel is fake.
//   4. The anthropic-passthrough provider calls maybeSubstituteAuth() which spots
//      the sentinel and swaps it for the live OAuth access token.
//
// Token sources (in priority order):
//   a. OPENCLAUDE_OAUTH_TOKEN env var — explicit operator override.
//   b. macOS Keychain ("Claude Code-credentials") — Claude Code v2.1.132+ stores
//      OAuth here instead of the plain JSON file (Electron safeStorage migration).
//   c. ~/.claude/.credentials.json — legacy file, kept for backward compatibility.
//
// Expired tokens (has expiresAt in the past) are treated as missing.

import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const SENTINEL_AUTH_TOKEN = "oc-discovery-sentinel-do-not-store";

const CREDENTIALS_FILE = join(homedir(), ".claude", ".credentials.json");
const KEYCHAIN_SERVICE = "Claude Code-credentials";

export function isTokenExpired(expiresAt) {
  if (typeof expiresAt !== "number") return false;
  // Timestamps > 1e12 are in milliseconds (seconds would be year ~33,000).
  const expiresAtMs = expiresAt > 1e12 ? expiresAt : expiresAt * 1000;
  return Date.now() >= expiresAtMs;
}

export async function readKeychainToken() {
  // Tests set this to bypass the Keychain — on a macOS dev machine with a
  // live Claude Code login, the Keychain always shadows the file fallback,
  // so file-fallback tests can't run without this escape hatch.
  if (process.env.OPENCLAUDE_DISABLE_KEYCHAIN === "1") return null;
  try {
    const { stdout } = await execFileAsync("security", [
      "find-generic-password",
      "-s", KEYCHAIN_SERVICE,
      "-w",
    ]);
    const json = JSON.parse(stdout.trim());
    const oauth = json?.claudeAiOauth;
    if (!oauth || typeof oauth.accessToken !== "string" || oauth.accessToken.length === 0) {
      return null;
    }
    if (isTokenExpired(oauth.expiresAt)) return null;
    return oauth.accessToken;
  } catch {
    return null;
  }
}

export async function readOauthAccessToken() {
  // 1. Explicit env var override.
  const envToken = process.env.OPENCLAUDE_OAUTH_TOKEN;
  if (envToken) return envToken;

  // 2. macOS Keychain (Claude Code v2.1.132+).
  const keychainToken = await readKeychainToken();
  if (keychainToken) return keychainToken;

  // 3. Legacy credentials file.
  try {
    const raw = await readFile(CREDENTIALS_FILE, "utf8");
    const json = JSON.parse(raw);
    const oauth = json?.claudeAiOauth;
    const token = oauth?.accessToken;
    if (typeof token !== "string" || token.length === 0) return null;
    if (isTokenExpired(oauth?.expiresAt)) return null;
    return token;
  } catch {
    return null;
  }
}

// If the incoming Authorization header carries our sentinel, swap it for the
// live OAuth bearer; otherwise leave it untouched.
export async function maybeSubstituteAuth(headers) {
  const auth = headers.get("authorization");
  if (!auth) return;
  // Bearer <token> or just <token>; tolerate either.
  const m = auth.match(/^Bearer\s+(.+)$/i);
  const token = m ? m[1] : auth;
  if (token !== SENTINEL_AUTH_TOKEN) return;
  const real = await readOauthAccessToken();
  if (!real) {
    // Couldn't read the token. Leave the sentinel; upstream will 401, which
    // is a clearer error than silently sending an empty header.
    return;
  }
  headers.set("authorization", `Bearer ${real}`);
  // x-api-key is sometimes also set; mirror behavior so api.anthropic.com sees
  // a single canonical bearer.
  headers.delete("x-api-key");
}
