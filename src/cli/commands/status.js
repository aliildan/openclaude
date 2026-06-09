import { readFile } from "node:fs/promises";
import { getDaemonStatus, daemonPaths } from "../daemon.js";
import { loadConfig } from "../../router/config.js";
import { SUBAGENT_DEFAULT_LABEL } from "./model-subagent.js";
import { CLASSIFIER_DEFAULT_LABEL } from "./model-internal-classifier.js";
import { SUBAGENT_ACTIVE_FILE, CLASSIFIER_ACTIVE_FILE } from "./model-selector.js";

// Width of the left-hand label column so "subagent:" and "classifier:" align.
const LABEL_W = 12;
const label = (s) => `${s}:`.padEnd(LABEL_W);
const indent = " ".repeat(LABEL_W);

export async function status() {
  const d = await getDaemonStatus();
  const cfg = await loadConfig();

  const lines = [];
  lines.push(`router:    ${d.running ? `running (pid ${d.pid}, port ${d.port})` : "stopped"}`);
  lines.push(`config:    ${d.configPath}`);
  lines.push(`pid file:  ${daemonPaths.pidFile}`);
  lines.push(`log file:  ${daemonPaths.logFile}`);
  lines.push(`providers:`);
  for (const [id, p] of Object.entries(cfg.providers ?? {})) {
    lines.push(`  ${id.padEnd(14)} ${p.type.padEnd(22)} ${p.baseUrl}`);
  }

  // Subagent model: show configured vs active-in-session
  const configured = cfg.subagentModel ?? SUBAGENT_DEFAULT_LABEL;
  lines.push(`${label("subagent")}${configured} (configured)`);
  if (d.running) {
    try {
      const active = (await readFile(SUBAGENT_ACTIVE_FILE, "utf8")).trim() || null;
      const activeLabel = active ?? SUBAGENT_DEFAULT_LABEL;
      lines.push(`${label("subagent")}${activeLabel} (active in session)`);
      if ((cfg.subagentModel ?? "") !== (active ?? "")) {
        lines.push(`${indent}↑ pending change — restart oc to apply`);
      }
    } catch {
      lines.push(`${label("subagent")}(active session has no subagent state file)`);
    }
  } else {
    lines.push(`${label("subagent")}(no active session)`);
  }

  // Internal-classifier model: show configured vs active-in-session
  const classifierConfigured = cfg.internalClassifierModel ?? CLASSIFIER_DEFAULT_LABEL;
  lines.push(`${label("classifier")}${classifierConfigured} (configured)`);
  if (d.running) {
    try {
      const classifierActive = (await readFile(CLASSIFIER_ACTIVE_FILE, "utf8")).trim() || null;
      const classifierActiveLabel = classifierActive ?? CLASSIFIER_DEFAULT_LABEL;
      lines.push(`${label("classifier")}${classifierActiveLabel} (active in session)`);
      if ((cfg.internalClassifierModel ?? "") !== (classifierActive ?? "")) {
        lines.push(`${indent}↑ pending change — restart oc to apply`);
      }
    } catch {
      lines.push(`${label("classifier")}(active session has no classifier state file)`);
    }
  } else {
    lines.push(`${label("classifier")}(no active session)`);
  }

  console.log(lines.join("\n"));
}
