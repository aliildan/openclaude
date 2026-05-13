import { spawn } from "node:child_process";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { paths, ensureConfig, loadConfig } from "../router/config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PID_FILE = join(paths.dir, "router.pid");
const LOG_FILE = join(paths.dir, "router.log");
const ROUTER_ENTRY = join(__dirname, "..", "router", "index.js");

async function readPidFile() {
  try {
    const raw = await readFile(PID_FILE, "utf8");
    const pid = Number(raw.trim());
    if (!Number.isInteger(pid) || pid <= 0) return null;
    return pid;
  } catch {
    return null;
  }
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export async function getDaemonStatus() {
  const pid = await readPidFile();
  if (pid && isAlive(pid)) {
    const cfg = await loadConfig();
    return { running: true, pid, port: cfg.port ?? 11436, configPath: paths.file };
  }
  if (pid) await unlink(PID_FILE).catch(() => {});
  return { running: false, pid: null, port: null, configPath: paths.file };
}

export async function ensureDaemonRunning() {
  await ensureConfig();
  const status = await getDaemonStatus();
  if (status.running) return status;

  const cfg = await loadConfig();
  const port = cfg.port ?? 11436;

  const out = await import("node:fs").then((m) => m.openSync(LOG_FILE, "a"));
  const child = spawn(process.execPath, [ROUTER_ENTRY], {
    detached: true,
    stdio: ["ignore", out, out],
    env: { ...process.env, OPENCLAUDE_PORT: String(port) },
  });
  child.unref();

  await writeFile(PID_FILE, String(child.pid));

  // wait until the port answers
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/openclaude/status`);
      if (res.ok) return { running: true, pid: child.pid, port, configPath: paths.file };
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Router daemon did not become ready within 5s (logs: ${LOG_FILE})`);
}

export async function stopDaemon() {
  const pid = await readPidFile();
  if (!pid) return { stopped: false, reason: "no pid file" };
  if (!isAlive(pid)) {
    await unlink(PID_FILE).catch(() => {});
    return { stopped: false, reason: "not running" };
  }
  try { process.kill(pid, "SIGTERM"); } catch {}
  await unlink(PID_FILE).catch(() => {});
  return { stopped: true, pid };
}

export const daemonPaths = { pidFile: PID_FILE, logFile: LOG_FILE };
