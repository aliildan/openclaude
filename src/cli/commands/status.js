import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getDaemonStatus, daemonPaths } from "../daemon.js";
import { loadConfig, paths } from "../../router/config.js";
import { SUBAGENT_DEFAULT_LABEL } from "./model-subagent.js";
import { CLASSIFIER_DEFAULT_LABEL } from "./model-internal-classifier.js";

const SUBAGENT_ACTIVE_FILE = join(paths.dir, "subagent-active");
const CLASSIFIER_ACTIVE_FILE = join(paths.dir, "internal-classifier-active");

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
  lines.push(`subagent:  ${configured} (configured)`);
  if (d.running) {
    try {
      const active = (await readFile(SUBAGENT_ACTIVE_FILE, "utf8")).trim() || null;
      const activeLabel = active ?? SUBAGENT_DEFAULT_LABEL;
      lines.push(`subagent:  ${activeLabel} (active in session)`);
      if ((cfg.subagentModel ?? "") !== (active ?? "")) {
        lines.push(`           ↑ pending change — restart oc to apply`);
      }
    } catch {
      lines.push(`subagent:  (active session has no subagent state file)`);
    }
  } else {
    lines.push(`subagent:  (no active session)`);
  }

  // Internal-classifier model: show configured vs active-in-session
  const classifierConfigured = cfg.internalClassifierModel ?? CLASSIFIER_DEFAULT_LABEL;
  lines.push(`classifier: ${classifierConfigured} (configured)`);
  if (d.running) {
    try {
      const classifierActive = (await readFile(CLASSIFIER_ACTIVE_FILE, "utf8")).trim() || null;
      const classifierActiveLabel = classifierActive ?? CLASSIFIER_DEFAULT_LABEL;
      lines.push(`classifier: ${classifierActiveLabel} (active in session)`);
      if ((cfg.internalClassifierModel ?? "") !== (classifierActive ?? "")) {
        lines.push(`           ↑ pending change — restart oc to apply`);
      }
    } catch {
      lines.push(`classifier: (active session has no classifier state file)`);
    }
  } else {
    lines.push(`classifier: (no active session)`);
  }

  console.log(lines.join("\n"));
}
