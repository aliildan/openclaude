import { start } from "./commands/start.js";
import { stop } from "./commands/stop.js";
import { status } from "./commands/status.js";
import { list } from "./commands/list.js";

const HELP = `openclaude — multi-provider router for Claude Code

Usage:
  openclaude start [-- claude args...]   Boot router daemon and exec into claude
  openclaude start --bridge=aggressive   Bind Sonnet+Opus aliases to Ollama too (3 slots vs 1)
  openclaude stop                        Shut down the router daemon
  openclaude status                      Show router state and providers
  openclaude list                        List installed Ollama models with /model commands

Notes:
  - Authentication: Claude Code's normal OAuth subscription is preserved.
    The router forwards the Authorization header to api.anthropic.com untouched.
  - The /model picker shows ONE Ollama model by default (the Custom slot).
    For more, paste "/model ollama-local:<name>" into /model — these don't
    show display names but they work.
  - NEVER hijack the Haiku alias — it's used for Claude Code's safety classifier.

Config: ~/.openclaude/config.json (auto-seeded).
`;

const COMMANDS = { start, stop, status, list, help: () => console.log(HELP) };

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
