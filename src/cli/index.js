import { start } from "./commands/start.js";
import { stop } from "./commands/stop.js";
import { status } from "./commands/status.js";
import { list } from "./commands/list.js";
import { modelSubagent } from "./commands/model-subagent.js";
import { modelInternalClassifier } from "./commands/model-internal-classifier.js";

const HELP = `openclaude — multi-provider router for Claude Code

Usage:
  openclaude start [-- claude args...]   Boot router daemon and exec into claude
  openclaude start --bridge=aggressive   Bind Sonnet+Opus aliases to Ollama too (3 slots vs 1)
  openclaude stop                        Shut down the router daemon
  openclaude status                      Show router state and providers
  openclaude list                        List installed Ollama models with /model commands
  openclaude model-subagent              Show/select subagent model for Claude Code
  openclaude model-subagent <n>          Set subagent model (takes effect on next 'oc start')
  openclaude internal-classifier         Show/select model for Claude Code's safety classifier
  openclaude internal-classifier <n>     Set classifier model (default: Anthropic Haiku)

Notes:
  - Authentication: Claude Code's normal OAuth subscription is preserved.
    The router forwards the Authorization header to api.anthropic.com untouched.
  - The /model picker shows ONE Ollama model by default (the Custom slot).
    For more, paste "/model ollama-local:<name>" into /model — these don't
    show display names but they work.
  - internal-classifier overrides Claude Code's built-in Haiku model used for
    safety classification and background tasks. Useful when Anthropic limits
    are exhausted or when running fully offline.

Config: ~/.openclaude/config.json (auto-seeded).
`;

const COMMANDS = { start, stop, status, list, "model-subagent": modelSubagent, "internal-classifier": modelInternalClassifier, help: () => console.log(HELP) };

const [, , cmd, ...rest] = process.argv;

if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") {
  console.log(HELP);
  process.exit(0);
}

const handler = COMMANDS[cmd];
if (!handler) {
  console.error(`unknown command: ${cmd}\n`);
  console.error(HELP);
  process.exit(2);
}

try {
  await handler(rest);
} catch (err) {
  console.error(`error: ${err.message}`);
  if (process.env.OPENCLAUDE_DEBUG) console.error(err.stack);
  process.exit(1);
}
