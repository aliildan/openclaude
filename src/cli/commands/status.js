import { getDaemonStatus, daemonPaths } from "../daemon.js";
import { loadConfig } from "../../router/config.js";

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
  console.log(lines.join("\n"));
}
