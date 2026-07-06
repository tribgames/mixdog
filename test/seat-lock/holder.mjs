// Test holder: acquires the seat lock and stays alive until taken over or
// killed. Prints single-line status tokens the orchestrator asserts on.
//   argv: <instanceId> <runtimeRoot> <force|vacant>
import { createSeatLock } from "../../src/runtime/channels/lib/seat-lock.mjs";

const [, , id, runtimeRoot, mode = "force"] = process.argv;
const lock = createSeatLock({ runtimeRoot, instanceId: id });
lock.onTakeover(async () => {
  process.stdout.write(`TAKEOVER ${id}\n`);
  await lock.closeSeatServer();
  process.exit(0);
});
const force = mode !== "vacant";
const ok = await lock.acquireSeat({ force, timeoutMs: 8000 });
process.stdout.write(`${ok ? "ACQUIRED" : "BACKOFF"} ${id}\n`);
if (!ok) process.exit(2);
// Ref'd keep-alive (the seat server is unref'd) so the holder survives to serve
// takeover messages until the orchestrator kills it.
setInterval(() => {}, 1000);
