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
//      the sentinel and swaps it for the live OAuth access token read from
//      ~/.claude/.credentials.json (fresh on every request — handles rotation).
//
// We never persist the OAuth token anywhere; we re-read it from disk on each
// request to pick up Claude Code's own refreshes.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const SENTINEL_AUTH_TOKEN = "oc-discovery-sentinel-do-not-store";

const CREDENTIALS_FILE = join(homedir(), ".claude", ".credentials.json");

export async function readOauthAccessToken() {
  try {
    const raw = await readFile(CREDENTIALS_FILE, "utf8");
    const json = JSON.parse(raw);
    const token = json?.claudeAiOauth?.accessToken;
    return typeof token === "string" && token.length > 0 ? token : null;
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
