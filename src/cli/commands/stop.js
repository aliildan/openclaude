import { stopDaemon } from "../daemon.js";

export async function stop() {
  const result = await stopDaemon();
  if (result.stopped) console.log(`stopped router (pid ${result.pid})`);
  else console.log(`router not running (${result.reason})`);
}
