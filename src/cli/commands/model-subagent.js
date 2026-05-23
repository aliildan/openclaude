import { createModelSelector } from "./model-selector.js";

const selector = createModelSelector({
  configKey: "subagentModel",
  activeFileName: "subagent-active",
  cliName: "model-subagent",
  defaultLabel: "default (Anthropic)",
  defaultMenuLabel: "default (Anthropic) — unset override",
  warningFallbackLabel: "Anthropic default",
  setMessageLabel: "Subagent",
  headerLines: [
    "═══ Subagent Model ═══",
    "The model used for Claude Code sub-agents",
    "(e.g. when running parallel agents, /loop, or scheduled tasks)",
  ],
});

export const resolveSubagentModel = selector.resolveModel;
export const modelSubagent = selector.command;
export const SUBAGENT_DEFAULT_LABEL = selector.defaultLabel;
