# openclaude

[![npm version](https://img.shields.io/npm/v/@aliildan/openclaude.svg)](https://www.npmjs.com/package/@aliildan/openclaude)
[![node](https://img.shields.io/node/v/@aliildan/openclaude.svg)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](https://opensource.org/licenses/MIT)

> **One Claude Code session, every model.** Keep your Anthropic Claude subscription for the main chat and route subagents, background tasks, or whole conversations to **local or cloud Ollama** models — all from the same `/model` picker, without leaving Claude Code.

openclaude is a tiny router that sits between the `claude` CLI and the model backends. Your Claude subscription auth is forwarded untouched; everything Ollama is auto-discovered and dispatched by name. No API keys to juggle, no build step — just Node.

![openclaude /model picker screenshot](openclaude.png)

## Quickstart

**Requirements:** [Claude Code](https://claude.com/claude-code) ≥ v2.1.129 (logged in), [Node.js](https://nodejs.org) ≥ 20, and — optionally — [Ollama](https://ollama.com/download) if you want to route to Ollama models.

```bash
# 1. Install
npm install -g @aliildan/openclaude

# 2. (optional) make sure Ollama is running with at least one model
ollama serve &
ollama pull qwen2.5-coder

# 3. Boot the router and drop into Claude Code
oc start
```

`oc start` prints what it wired up, then execs `claude`:

```
[openclaude] router on http://127.0.0.1:11436
[openclaude] found 3 Ollama model(s):
  - qwen2.5-coder:7b
  - gemma4:31b-cloud
  - llama3.2:3b
[openclaude] mode: conservative (safe) · discovery: ON (all Ollama models in /model)
[openclaude] /model picker bindings (friendly names):
  (Custom) → qwen2.5-coder:7b
  Default + Sonnet + Opus + Haiku → real Anthropic via your subscription
```

Then inside Claude Code:

```
/model
# pick any Ollama entry (auto-discovered) or the (Custom) slot
# or paste a raw "/model ollama-local:<name>" command
```

Upgrade any time with `npm install -g @aliildan/openclaude@latest`. The package is scoped (`@aliildan/openclaude`), but the commands stay `oc` / `openclaude`, and `oc start` works from any directory on Linux, macOS, and Windows.

## Features

- **🔌 Keep your Claude subscription** — Claude Code's OAuth bearer is forwarded to `api.anthropic.com` untouched. No `ANTHROPIC_API_KEY` required.
- **🧩 Every Ollama model in `/model`** — auto-discovered from your Ollama install and selectable like any other model in the picker.
- **☁️ Frontier open-weight models without a GPU** — route to [Ollama Cloud](https://ollama.com/cloud) (`gpt-oss:120b`, `qwen3:480b`, `deepseek-v3.1:671b`, `kimi-k2:1t`, …) through the same workflow.
- **💸 Cheap subagents** — send the Explore / Plan / general-purpose subagents to a local model while your main conversation stays on Anthropic Claude.
- **🛡️ Cross-provider safety** — sanitizes tool-use ids, thinking-block signatures, images, and malformed SSE streams so switching models mid-conversation just works.
- **🪶 Thin & local** — single-file Node.js ESM, no build step, bound to `127.0.0.1`.

## How it works

```
┌──────────────┐  ANTHROPIC_BASE_URL      ┌────────────────────┐
│ claude (CLI) │ ────────────────────────►│ openclaude router  │
│  /model      │  Authorization passed    │  127.0.0.1:11436   │
└──────────────┘  through                 └─────────┬──────────┘
                                                    │ parse "provider:modelId"
                                  ┌─────────────────┼─────────────────┐
                                  ▼                 ▼                 ▼
                       api.anthropic.com    localhost:11434      ollama.com
                       (your OAuth)         (no auth)            (x-api-key)
```

When you select a model in `/model`:
- Picker entry **`Default` / `Sonnet` / `Opus` / `Haiku`** → routed to **real Anthropic** via your subscription.
- Picker entries **`<ollama-name> (ollama-local)`** (auto-discovered from your Ollama install) → routed to **local Ollama**.
- Picker entry **`<name> (Ollama)`** (the Custom alias slot) → routed to **local Ollama**.
- Anything you type, e.g. `/model ollama-local:gemma4:31b-cloud` → routed by parsing the prefix.

### Discovery mode (default ON)

To get **all** your Ollama models in the picker, openclaude sets `ANTHROPIC_AUTH_TOKEN` to a sentinel before launching `claude`. This makes Claude Code trigger gateway model discovery — Claude Code calls `GET /v1/models` on our router and the router enumerates every installed Ollama model.

For inference, the router intercepts the sentinel token in the `Authorization` header and substitutes the **live OAuth bearer** read from `~/.claude/.credentials.json` (re-read on every request, so token rotation is handled). Your subscription still pays for Anthropic-bound traffic.

> **Side-effect of setting `ANTHROPIC_AUTH_TOKEN`** (per Claude Code's own changelog): the following are **disabled** for the session — Remote Control, `/schedule`, claude.ai MCP connectors, notification preferences. Subscription inference and everything else is unaffected. Pass `oc start --no-discovery` to keep them, at the cost of seeing fewer Ollama models in the picker.

## Guides

### Subagent model — cheaper background work

Claude Code's Explore, Plan, and general-purpose subagents can be expensive because they read many files and digest verbose output. `oc model-subagent` redirects subagent traffic to a cheaper model (like a local Ollama model) while keeping your main conversation on Anthropic Claude.

```bash
oc model-subagent          # show current setting + available models
oc model-subagent 2        # select a model by number
oc model-subagent 0        # reset to Anthropic default (or: oc model-subagent default)
```

**How it works:** `oc model-subagent` writes a `subagentModel` key to `~/.openclaude/config.json`. On the next `oc start`, the router sets `CLAUDE_CODE_SUBAGENT_MODEL` before launching `claude`. Claude Code reads this once at startup, so **changes do not take effect in a running session** — restart `oc` to apply them. The numbered menu offers `0` (default/unset), `1..N` (installed Ollama models routed as `ollama-local:<name>`), and Anthropic models (e.g. Haiku, using your subscription). If the configured model is no longer installed at `oc start`, the router falls back to the Anthropic default and warns. `oc status` shows both the configured value and the value active in the current session.

### Bridge modes for the alias slots

Even with discovery on, openclaude can rebind Claude Code's built-in alias slots (Custom / Sonnet / Opus) to specific Ollama models so they get **friendly display names** in the picker. Aliases are filled from your Ollama list in order.

| Mode                       | What it does                                                                  | Anthropic aliases lost |
| -------------------------- | ---------------------------------------------------------------------------- | ---------------------- |
| **conservative** (default) | Bind the **Custom** slot to your first Ollama model.                          | none                   |
| **aggressive**             | Also bind **Sonnet** and **Opus** alias slots to your next two Ollama models. | Sonnet, Opus           |

Enable aggressive bridging with `oc start --bridge=aggressive`.

> **🚫 Haiku is never bridged**, in either mode. Claude Code uses the `haiku` alias for its background safety classifier, title generation, and summarization. Routing those to Ollama makes Bash and other tools fail with `"default is temporarily unavailable"`. (To override Haiku deliberately, use `oc internal-classifier`.)

### Ollama: local & cloud

**Local Ollama** — the default config assumes Ollama at `http://127.0.0.1:11434`. Since v0.14, Ollama serves the Anthropic Messages API at `/v1/messages` natively, so no translation layer is needed.

```bash
ollama serve &           # if not already running
ollama pull qwen2.5-coder
oc list                  # confirm openclaude sees it
```

**Ollama Cloud** ([ollama.com/cloud](https://ollama.com/cloud)) hosts large open-weight models (200B–1T parameters) behind the same Anthropic-compatible endpoint, so openclaude routes to it identically. Mix your Claude subscription with frontier OSS models like `gpt-oss:120b-cloud`, `qwen3:480b-cloud`, `deepseek-v3.1:671b-cloud`, or `kimi-k2:1t-cloud` — none of which fit on consumer hardware — without leaving Claude Code.

```bash
# Option A — pull cloud models into local Ollama (most common).
# They appear in /model via discovery and route through ollama-local.
ollama pull gpt-oss:120b-cloud
oc start

# Option B — hit ollama.com directly, no local registration.
export OLLAMA_API_KEY=<your-key-from-ollama.com>
oc start
# In /model: paste "/model ollama-cloud:<name>"
```

The default config ships `ollama-cloud` with `apiKey: "$OLLAMA_API_KEY"`; the router substitutes the env var at request time. Get a key at [ollama.com](https://ollama.com/cloud).

## Reference

### Commands

| Command                        | What it does                                                |
| ------------------------------ | ----------------------------------------------------------- |
| `oc start`                     | Boot router (if needed); exec `claude` with router env set. |
| `oc start --bridge=aggressive` | Also bind Sonnet+Opus picker slots to Ollama (3 slots vs 1).|
| `oc start --no-discovery`      | Don't set the AUTH_TOKEN sentinel; alias slots only.        |
| `oc stop`                      | Shut down the router daemon.                                |
| `oc status`                    | Show daemon state + configured providers.                   |
| `oc list`                      | List installed Ollama models with paste-ready /model lines. |
| `oc model-subagent`            | Show/select subagent model for Claude Code.                 |
| `oc model-subagent <n>`        | Set subagent model by number (takes effect on next start).  |
| `oc internal-classifier`       | Show/select model for Claude Code's safety classifier.      |
| `oc internal-classifier <n>`   | Set classifier model by number (default: Anthropic Haiku).  |

### Configuration

Config lives at `~/.openclaude/config.json` (auto-seeded on first run). Add providers by editing it — changes are picked up on the next request, no daemon restart needed:

```json
{
  "port": 11436,
  "defaultProvider": "claude",
  "providers": {
    "claude":        { "type": "anthropic-passthrough", "baseUrl": "https://api.anthropic.com" },
    "ollama-local":  { "type": "ollama", "baseUrl": "http://127.0.0.1:11434" },
    "ollama-cloud":  { "type": "ollama", "baseUrl": "https://ollama.com", "apiKey": "$OLLAMA_API_KEY" },
    "remote-ollama": { "type": "ollama", "baseUrl": "http://192.168.1.50:11434" }
  }
}
```

> The daemon writes its pid/log/config under `~/.openclaude/` (or `%USERPROFILE%\.openclaude\` on Windows). Override with `OPENCLAUDE_HOME=/some/path`.

### Auth model

| Provider type           | Auth                                                                        |
| ----------------------- | --------------------------------------------------------------------------- |
| `anthropic-passthrough` | Claude Code's `Authorization` header is forwarded untouched. No key needed. |
| `ollama` (local)        | None — Ollama ignores the key.                                              |
| `ollama` (cloud)        | `x-api-key: $OLLAMA_API_KEY` (env-var-interpolated).                        |

<details>
<summary><strong>Under the hood</strong> — cross-provider sanitization, image-stripping, SSE fixup, tests</summary>

### Conversation-history sanitization

Cross-provider sessions accumulate metadata that the *next* provider can't validate. Two known cases, both fixed unconditionally on every outgoing request:

1. **Tool-use ids.** Anthropic requires `tool_use.id` to match `^[a-zA-Z0-9_-]+$`. Ollama's compat layer can emit ids with `.`, `:`, or `#`. Claude Code stores those in history and replays them — so when you switch back to a Claude model, Anthropic returns `400 messages.N.content.M.tool_use.id: String should match pattern ...`. The router rewrites dirty ids to `toolu_oc_<sanitized>` form and remaps the matching `tool_result.tool_use_id` so the call/result graph stays coherent.
2. **Thinking-block signatures.** Anthropic cryptographically signs every `thinking` block it emits and validates the signature on replay. Non-Anthropic upstreams (Ollama, our stream-fixup synthesizer) emit thinking blocks with empty or placeholder signatures, which Anthropic later rejects with `400 messages.N.content.M: Invalid signature in thinking block`. The router scans for thinking blocks whose signature looks fake (missing or shorter than ~64 chars) and replaces them with a `[thinking from a prior model omitted]` text marker. Real Anthropic signatures are preserved untouched.

Log lines confirm when either fires: `sanitized N dirty tool_use id(s)` / `dropped N thinking block(s) with non-Anthropic signature`.

### Image-stripping for text-only models

Claude Code re-sends the full conversation history every turn, so an image you attached three turns ago is still in the request when you switch to a text-only model like `gpt-oss:120b-cloud`. Without intervention, that model returns 400 `"this model does not support image input"` and you can't continue.

The router probes each Ollama model's capabilities via `/api/show` (cached in-process), and for models that don't list `vision`, strips `image` content blocks — replacing them with a `[image omitted]` text marker. Vision-capable models are unaffected; nested images inside tool-result blocks are handled too. A startup line `[openclaude] stripped N image block(s) for text-only model X` confirms when this fires.

### SSE stream sanitizer

Ollama's Anthropic-compat layer occasionally emits a `content_block_delta` event for an index it never opened with `content_block_start` — Claude Code's stream parser then aborts with `"Content block not found"` and retries forever (seen on multimodal models like `kimi-k2.6:cloud`). The router wraps every Ollama streaming response in a sanitizer (`src/router/stream-fixup.js`) that tracks open content-block indices, synthesizes the missing `content_block_start` for orphan deltas (matching type — text, thinking, or tool_use with a placeholder id), tracks `content_block_stop` so re-used indices re-synthesize, and passes everything else through byte-for-byte. Anthropic-passthrough responses (real Claude) are never touched.

The router is also resilient to upstream streams that fail *after* forwarding has begun (e.g. an upstream body timeout): the partial response is closed cleanly and the daemon keeps serving rather than crashing.

### Tests

```bash
npm test
```

Node's built-in test runner covers `parseModelTarget` routing; a real-router-vs-stub e2e (OAuth pass-through, Ollama `x-api-key`, no header leakage, discovery decoding); the SSE sanitizer; image stripping; tool-use id + thinking-signature sanitization; subagent-model resolution/config round-trip; and the mid-stream upstream-failure regression.

</details>

## Limitations

- **`tool_choice` forcing isn't supported** by Ollama's Anthropic-compat layer; some models may degrade tool-use behavior.
- **Synthesized `tool_use` blocks** (from an orphan `input_json_delta` with no preceding start) get a placeholder `id` and `name: "unknown"` — the call still executes parser-side but downstream tool routing may fail. Vision/text deltas have no such caveat.
- Only `anthropic-passthrough` and `ollama` provider types are supported today. OpenAI / OpenRouter / Bedrock / Vertex are deferred (the abstraction is ready).
- **Discovery mode disables Remote Control / `/schedule` / claude.ai MCP / notification prefs** for the session (a Claude Code requirement). Use `--no-discovery` to keep them.

## Status

**v0.1.0** — small Node.js ESM router + CLI, no build step, no runtime dependencies. [MIT licensed](https://opensource.org/licenses/MIT).
