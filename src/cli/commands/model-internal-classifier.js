import { createModelSelector, CLASSIFIER_ACTIVE_FILENAME } from "./model-selector.js";

const selector = createModelSelector({
  configKey: "internalClassifierModel",
  activeFileName: CLASSIFIER_ACTIVE_FILENAME,
  cliName: "internal-classifier",
  defaultLabel: "default (Anthropic Haiku)",
  defaultMenuLabel: "default (Anthropic Haiku — safety classifier & internal tasks)",
  warningFallbackLabel: "Anthropic Haiku default",
  setMessageLabel: "Internal-classifier",
  headerLines: [
    "═══ Internal Classifier Model ═══",
    "Claude Code's background tasks (safety classifier, tool safety checks, syntax validation)",
    "Default is Anthropic Haiku. Override to save subscription quota or run fully offline.",
  ],
});

export const resolveInternalClassifierModel = selector.resolveModel;
export const modelInternalClassifier = selector.command;
export const CLASSIFIER_DEFAULT_LABEL = selector.defaultLabel;
