// Shared implementation for `oc model-subagent` and `oc internal-classifier`.
// Both commands let users redirect a Claude Code env-var slot to an Ollama
// model (or back to the Anthropic default). The logic is identical aside from
// the config key, active-file name, default label, and a few strings.

import { loadConfig, saveConfig, parseModelTarget, paths } from "../../router/config.js";
import { listLocalOllamaModels } from "../ollama.js";
import { getDaemonStatus } from "../daemon.js";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { stdin, stdout } from "node:process";

export const ANTHROPIC_MODELS = [
  { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5 (uses subscription)" },
];

export function createModelSelector({
  configKey,
  activeFileName,
  cliName,
  defaultLabel,
  defaultMenuLabel,
  warningFallbackLabel,
  setMessageLabel,
  headerLines,
}) {
  const activeFile = join(paths.dir, activeFileName);

  function buildModelList(ollamaModels) {
    const entries = [{ id: null, label: defaultMenuLabel }];
    for (const m of ollamaModels) {
      entries.push({ id: `ollama-local:${m.name}`, label: `${m.name} (Ollama)` });
    }
    for (const a of ANTHROPIC_MODELS) {
      entries.push({ id: a.id, label: a.label });
    }
    return entries;
  }

  function resolveModel(configuredModel, ollamaModels, cfg) {
    if (!configuredModel) return { envValue: null, warning: null };
    const parsed = parseModelTarget(configuredModel, cfg);
    if (parsed.providerId === "ollama-local") {
      const stillInstalled = ollamaModels.some((m) => m.name === parsed.modelId);
      if (!stillInstalled) {
        return {
          envValue: null,
          warning: `configured ${cliName} model "${configuredModel}" is no longer installed locally — falling back to ${warningFallbackLabel}`,
        };
      }
    }
    return { envValue: configuredModel, warning: null };
  }

  async function readActive() {
    try {
      const raw = await readFile(activeFile, "utf8");
      return raw.trim() || null;
    } catch {
      return null;
    }
  }

  function printMenu(entries, configuredId) {
    console.log("");
    console.log("Available models:");
    for (let i = 0; i < entries.length; i++) {
      const marker = entries[i].id === configuredId ? " ← currently selected" : "";
      console.log(`  ${i}. ${entries[i].label}${marker}`);
    }
    console.log("");
  }

  function printHeader() {
    console.log("");
    for (const line of headerLines) console.log(line);
    console.log("");
  }

  function applySelection(cfg, entries, index) {
    const chosen = entries[index];
    if (chosen.id === null) {
      const next = { ...cfg };
      delete next[configKey];
      return { cfg: next, label: defaultLabel };
    }
    const updated = { ...cfg, [configKey]: chosen.id };
    return { cfg: updated, label: chosen.id };
  }

  async function showStatus(configured) {
    const configuredLabel = configured ?? defaultLabel;
    console.log(`Configured: ${configuredLabel}`);
    const daemon = await getDaemonStatus();
    if (daemon.running) {
      const active = await readActive();
      const activeLabel = active ?? defaultLabel;
      console.log(`Active:     ${activeLabel}`);
      if (configured !== active) {
        console.log(`  ↑ configured value is pending — restart oc to apply`);
      }
    } else {
      console.log(`Active:     (no active session)`);
    }
  }

  function parseInput(input, entries) {
    if (input === "default") return 0;
    if (/^\d+$/.test(input)) return Number(input);
    const normalized = input.startsWith("ollama-local:") ? input : `ollama-local:${input}`;
    return entries.findIndex(
      (e) => e.id === input || e.id === normalized || e.id === `ollama-local:${input}`,
    );
  }

  async function promptForSelection(entries, configured) {
    const isTty = stdout.isTTY && stdin.isTTY;
    if (!isTty) {
      console.log(`Stdin is not a TTY. Run 'oc ${cliName} <number>' to select.`);
      return null;
    }

    const rl = createInterface({ input: stdin, output: stdout });
    const answer = await new Promise((resolve) => {
      rl.question("Pick a model number (or press Ctrl+C to cancel): ", (ans) => {
        resolve(ans.trim());
      });
    });
    rl.close();

    if (answer === "") {
      console.log("Cancelled. No changes made.");
      return null;
    }

    const index = parseInput(answer, entries);
    if (index < 0 || index >= entries.length) {
      console.error(`Invalid selection: ${answer}`);
      printMenu(entries, configured);
      console.log(`Run 'oc ${cliName} <number>' to select.`);
      process.exit(1);
    }
    return index;
  }

  async function command(args) {
    const cfg = await loadConfig();
    const ollamaBase = cfg.providers?.["ollama-local"]?.baseUrl || "http://127.0.0.1:11434";
    const ollamaModels = await listLocalOllamaModels(ollamaBase);
    const entries = buildModelList(ollamaModels);
    const configured = cfg[configKey] ?? null;

    printHeader();
    await showStatus(configured);

    // No-argument mode: interactive prompt
    if (args.length === 0) {
      printMenu(entries, configured);
      const index = await promptForSelection(entries, configured);
      if (index === null) return;
      args = [String(index)];
    }

    // With-argument mode: validate and persist selection
    const input = args[0];
    const index = parseInput(input, entries);

    if (index < 0 || index >= entries.length) {
      console.error(`Invalid selection: ${input}`);
      printMenu(entries, configured);
      console.log(`Run 'oc ${cliName} <number>' to select.`);
      process.exit(1);
    }

    const { cfg: newCfg, label } = applySelection(cfg, entries, index);
    await saveConfig(newCfg);
    console.log(`${setMessageLabel} model set to ${label}.`);
    await writeFile(activeFile, entries[index].id || "");
    console.log("Change saved. Takes effect on next 'oc start'.");
  }

  return { resolveModel, command, defaultLabel };
}
