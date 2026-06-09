import { unlink } from "node:fs/promises";
import { stopDaemon } from "../daemon.js";
import { SUBAGENT_ACTIVE_FILE, CLASSIFIER_ACTIVE_FILE } from "./model-selector.js";

export async function stop() {
  const result = await stopDaemon();
  // Always clean the active-file state — they're transient and a stale file
  // from a previously-crashed session shouldn't survive an `oc stop`.
  await unlink(SUBAGENT_ACTIVE_FILE).catch(() => {});
  await unlink(CLASSIFIER_ACTIVE_FILE).catch(() => {});
  if (result.stopped) console.log(`stopped router (pid ${result.pid})`);
  else console.log(`router not running (${result.reason})`);
}
