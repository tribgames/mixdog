// Integration test for the OS-enforced bridge-seat singleton (seat-lock.mjs).
// Two node processes contend for one seat:
//   TEST1 explicit takeover — B acquires only after A releases on the takeover
//                             message (not last-wins file overwrite).
//   TEST2 crash auto-release — hard-kill (SIGKILL / TerminateProcess) the holder
//                             and confirm a claim-if-vacant contender then wins,
//                             proving the OS released the seat with no heartbeat.
import { spawn } from "child_process";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { fileURLToPath } from "url";

const here = fileURLToPath(new URL(".", import.meta.url));
const holder = join(here, "holder.mjs");
const root = mkdtempSync(join(tmpdir(), "seat-test-"));
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function spawnHolder(id, mode) {
  const p = spawn(process.execPath, [holder, id, root, mode], { stdio: ["ignore", "pipe", "pipe"] });
  p.stdout.on("data", (d) => process.stdout.write(`[${id}] ${d}`));
  p.stderr.on("data", (d) => process.stderr.write(`[${id}!] ${d}`));
  return p;
}
function waitFor(p, re, timeoutMs = 9000) {
  return new Promise((resolve, reject) => {
    let buf = "";
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${re} (saw: ${buf.trim()})`)), timeoutMs);
    p.stdout.on("data", (d) => {
      buf += d.toString();
      if (re.test(buf)) { clearTimeout(t); resolve(buf); }
    });
  });
}

let failed = false;
function check(cond, label) {
  process.stdout.write(`${cond ? "PASS" : "FAIL"} ${label}\n`);
  if (!cond) failed = true;
}

// ── TEST1: explicit takeover ────────────────────────────────────────────────
const A = spawnHolder("A", "force");
await waitFor(A, /ACQUIRED A/);
let aReleasedAt = 0;
A.stdout.on("data", (d) => { if (/TAKEOVER A/.test(d)) aReleasedAt = Date.now(); });
const B = spawnHolder("B", "force");
await waitFor(B, /ACQUIRED B/);
const bAcquiredAt = Date.now();
await delay(100);
check(aReleasedAt > 0, "TEST1 holder A released on takeover message");
check(aReleasedAt > 0 && bAcquiredAt >= aReleasedAt, "TEST1 B acquired only after A released");
A.kill(); B.kill();
await delay(400);

// ── TEST2: crash auto-release ───────────────────────────────────────────────
const C = spawnHolder("C", "force");
await waitFor(C, /ACQUIRED C/);
C.kill("SIGKILL"); // hard kill: no graceful release runs
await delay(600);
const D = spawnHolder("D", "vacant"); // claim-if-vacant: wins ONLY if seat truly free
const outD = await waitFor(D, /ACQUIRED D|BACKOFF D/);
check(/ACQUIRED D/.test(outD), "TEST2 D acquired vacant seat after C hard-kill (auto-release)");
D.kill();
await delay(200);

process.stdout.write(failed ? "RESULT: FAILED\n" : "RESULT: OK\n");
process.exit(failed ? 1 : 0);
