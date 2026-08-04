// Sampled memory guard for the renderer test suites.
//
// Runs a test command and samples the resident set size of the whole child
// process tree (node:test spawns one child per test file, so the parent RSS
// alone is meaningless), reports the peak, and terminates the tree when a
// sample crosses the cap.
//
// This is a SAMPLED ceiling, never a hard one: the tree is polled every
// --sample-ms plus probe latency, so an allocation spike that begins and ends
// between two samples is not observed. It is also not a defence against a
// hostile process — it terminates what it spawned and fails closed on what it
// can measure.
//
// Fails on: a sample above the cap, a probe failure while the child is alive,
// no valid sample at all, and any non-zero child exit.
//
// Usage:
//   node scripts/memory-guard.mjs --cap-mb=1200 --sample-ms=200 --label=renderer.dom \
//     -- node --test file.mjs
import { spawn, spawnSync } from "node:child_process";
import { writeSync } from "node:fs";
import { freemem } from "node:os";

const argv = process.argv.slice(2);
const separator = argv.indexOf("--");
const options = separator < 0 ? [] : argv.slice(0, separator);
const command = separator < 0 ? [] : argv.slice(separator + 1);
if (command.length === 0) {
  writeSync(2, "memory-guard: expected `-- <command> [args...]`\n");
  process.exit(64);
}
const readOption = (name, fallback) => {
  const hit = options.find((entry) => entry.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const capMb = Number(readOption("cap-mb", "1200"));
const minFreeMb = Number(readOption("min-free-mb", "2048"));
const sampleMs = Number(readOption("sample-ms", "250"));
const label = readOption("label", command.join(" ").slice(0, 60));
for (const [name, value] of [
  ["cap-mb", capMb],
  ["min-free-mb", minFreeMb],
  ["sample-ms", sampleMs],
]) {
  if (!Number.isFinite(value) || value <= 0) {
    writeSync(2, `memory-guard: invalid --${name}=${value}\n`);
    process.exit(64);
  }
}

// Test seams (scripts/memory-guard.test.mjs only).
const forceProbeFailure = process.env.MIXDOG_MEMGUARD_TEST_PROBE_FAILURE === "always";
const probeDelayMs = Number(process.env.MIXDOG_MEMGUARD_TEST_PROBE_DELAY_MS ?? 0) || 0;
const forcedFreeMbSequence = String(
  process.env.MIXDOG_MEMGUARD_TEST_FREE_MB_SEQUENCE || "",
).split(",").map((value) => value.trim()).filter(Boolean)
  .map(Number).filter((value) => Number.isFinite(value) && value >= 0);
let forcedFreeIndex = 0;

const isWindows = process.platform === "win32";
const log = (line) => { try { writeSync(2, `${line}\n`); } catch {} };
const mb = (bytes) => (bytes / (1024 * 1024)).toFixed(1);
const forcedSystemFreeBytes = () => {
  if (forcedFreeMbSequence.length === 0) return null;
  const index = Math.min(forcedFreeIndex, forcedFreeMbSequence.length - 1);
  forcedFreeIndex += 1;
  return forcedFreeMbSequence[index] * 1024 * 1024;
};
// Ref'd on purpose: these waits keep the guard alive while it finishes.
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

// pid / ppid / working set from the OS process table. No temp files and no
// per-platform peak accounting: current RSS only.
const PROBE_COMMAND = isWindows
  ? ["powershell", ["-NoLogo", "-NoProfile", "-Command",
    "$os = Get-CimInstance Win32_OperatingSystem; "
    + "\"FREE $([uint64]$os.FreePhysicalMemory * 1024)\"; "
    + "Get-CimInstance Win32_Process | ForEach-Object "
    + "{ \"$($_.ProcessId) $($_.ParentProcessId) $($_.WorkingSetSize)\" }"]]
  : ["ps", ["-A", "-o", "pid=,ppid=,rss="]];

const initialSystemFreeBytes = () => {
  const forced = forcedSystemFreeBytes();
  if (forced !== null) return forced;
  if (!isWindows) return freemem();
  // Node 22 can report os.freemem() as zero on Windows even while
  // Win32_OperatingSystem exposes gigabytes of FreePhysicalMemory. Use the
  // same authoritative source as the runtime process-table probe.
  const result = spawnSync("powershell", [
    "-NoLogo", "-NoProfile", "-Command",
    "(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory * 1024",
  ], { encoding: "utf8", windowsHide: true });
  if (result.error || result.status !== 0) return null;
  const parsed = Number(String(result.stdout || "").trim());
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};

/** One process-table snapshot: pid -> { ppid, rss }. */
const probe = async () => {
  if (probeDelayMs > 0) await sleep(probeDelayMs);
  if (forceProbeFailure) return { ok: false, reason: "forced probe failure (test seam)" };
  return await new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(PROBE_COMMAND[0], PROBE_COMMAND[1], { stdio: ["ignore", "pipe", "ignore"] });
    } catch (error) {
      resolve({ ok: false, reason: `probe spawn failed: ${error.message}` });
      return;
    }
    let out = "";
    let settled = false;
    const done = (result) => { if (!settled) { settled = true; resolve(result); } };
    proc.stdout.on("data", (chunk) => { out += chunk; });
    proc.on("error", (error) => done({ ok: false, reason: `probe spawn failed: ${error.message}` }));
    proc.on("close", (code) => {
      if (code !== 0) return done({ ok: false, reason: `probe exited with code ${code}` });
      const rows = new Map();
      let measuredFreeBytes = null;
      for (const line of out.split("\n")) {
        const parts = line.trim().split(/\s+/);
        if (parts[0] === "FREE") {
          const value = Number(parts[1]);
          if (Number.isFinite(value) && value >= 0) measuredFreeBytes = value;
          continue;
        }
        if (parts.length < 3) continue;
        const [pid, ppid, size] = parts.map(Number);
        if (![pid, ppid, size].every(Number.isFinite)) continue;
        // `ps` reports kilobytes; WMI reports bytes.
        rows.set(pid, { ppid, rss: isWindows ? size : size * 1024 });
      }
      if (rows.size === 0) return done({ ok: false, reason: "probe output could not be parsed" });
      const forcedFreeBytes = forcedSystemFreeBytes();
      const freeBytes = forcedFreeBytes !== null
        ? forcedFreeBytes
        : isWindows ? measuredFreeBytes : freemem();
      if (!Number.isFinite(freeBytes) || freeBytes < 0) {
        return done({ ok: false, reason: "system free memory could not be measured" });
      }
      done({ ok: true, rows, freeBytes });
    });
  });
};

// A tree cap is not usable headroom. Refuse to start unless the machine can
// absorb the entire allowed tree while still retaining the requested system
// reserve for the live desktop/provider and the OS.
const startFreeBytes = initialSystemFreeBytes();
const requiredStartBytes = (capMb + minFreeMb) * 1024 * 1024;
if (!Number.isFinite(startFreeBytes)) {
  log(`[memory-guard] ${label}: refusing to start — system free memory probe failed`);
  process.exit(74);
}
if (startFreeBytes < requiredStartBytes) {
  log(`[memory-guard] ${label}: refusing to start — system free ${mb(startFreeBytes)} MB`
    + ` is below required headroom ${(capMb + minFreeMb).toFixed(0)} MB`
    + ` (tree cap ${capMb} MB + reserve ${minFreeMb} MB)`);
  process.exit(75);
}

const child = spawn(command[0], command.slice(1), {
  stdio: "inherit",
  // Detached on POSIX so the whole tree starts in one process group we own.
  detached: !isWindows,
});

let peakBytes = 0;
let minimumFreeBytes = startFreeBytes;
let samples = 0;
let exceeded = false;
let systemPressure = false;
let guardError = null;
let childExit = null;
let stopped = false;
let finished = false;
let pendingSample = null;
let termination = null;
const trackedPids = new Set([child.pid]);

/** Total RSS of the child and every descendant, or null when the tree is gone. */
const treeRss = (rows) => {
  const childrenOf = new Map();
  for (const [pid, row] of rows) {
    if (!childrenOf.has(row.ppid)) childrenOf.set(row.ppid, []);
    childrenOf.get(row.ppid).push(pid);
  }
  const seen = new Set();
  const stack = [child.pid];
  let total = 0;
  let found = false;
  while (stack.length) {
    const pid = stack.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    const row = rows.get(pid);
    if (row) {
      trackedPids.add(pid);
      total += row.rss;
      found = true;
    }
    for (const descendant of childrenOf.get(pid) ?? []) stack.push(descendant);
  }
  return found ? total : null;
};

const taskkill = (pid, tree = false) => new Promise((resolve) => {
  const args = ["/PID", String(pid), ...(tree ? ["/T"] : []), "/F"];
  const killer = spawn("taskkill", args, { stdio: "ignore" });
  killer.on("error", () => resolve());
  killer.on("close", () => resolve());
});

async function terminateTrackedDescendants() {
  if (!isWindows) return;
  // A failed node:test parent can exit before its workers. At that point /T on
  // the old root no longer reaches re-parented descendants, so reap every PID
  // observed inside the owned tree as well. The root itself is handled by
  // terminate() while live and is excluded here to avoid PID-reuse risk.
  const descendants = [...trackedPids]
    .filter((pid) => pid !== child.pid && pid !== process.pid)
    .sort((left, right) => right - left);
  for (const pid of descendants) await taskkill(pid);
}

function terminate() {
  termination ??= (async () => {
    if (isWindows) {
      if (childExit === null) await taskkill(child.pid, true);
      await terminateTrackedDescendants();
      return;
    }
    // The child leads its own process group, so one signal reaches the tree.
    for (const signal of ["SIGTERM", "SIGKILL"]) {
      if (childExit !== null && signal === "SIGKILL") return;
      try {
        process.kill(-child.pid, signal);
      } catch {
        try { child.kill(signal); } catch {}
      }
      await sleep(250);
    }
  })();
  return termination;
}

const checkSystemMemory = (free) => {
  if (free < minimumFreeBytes) minimumFreeBytes = free;
  if (systemPressure || free >= minFreeMb * 1024 * 1024) return !systemPressure;
  systemPressure = true;
  log(`[memory-guard] ${label}: system free ${mb(free)} MB fell below reserve`
    + ` ${minFreeMb} MB — terminating test child`);
  stopped = true;
  void terminate();
  return false;
};

const record = (sample) => {
  if (!sample || sample.recorded) return;
  sample.recorded = true;
  if (!sample.ok) {
    if (!guardError && childExit === null) {
      guardError = `memory probe failed (${sample.reason})`;
      log(`[memory-guard] ${label}: ${guardError}`);
      stopped = true;
      void terminate();
    }
    return;
  }
  const total = treeRss(sample.rows);
  if (total === null) return;
  if (!checkSystemMemory(sample.freeBytes)) return;
  samples += 1;
  if (total > peakBytes) peakBytes = total;
  if (!exceeded && total > capMb * 1024 * 1024) {
    exceeded = true;
    log(`[memory-guard] ${label}: tree RSS ${mb(total)} MB exceeded cap ${capMb} MB — terminating test child`);
    stopped = true;
    void terminate();
  }
};

const samplingLoop = async () => {
  // The first sample is taken immediately: a short command must not go unseen.
  while (!stopped && childExit === null) {
    const startedAt = Date.now();
    const inFlight = probe();
    pendingSample = inFlight;
    record(await inFlight);
    if (pendingSample === inFlight) pendingSample = null;
    if (stopped || childExit !== null) break;
    const remaining = sampleMs - (Date.now() - startedAt);
    if (remaining > 0) await sleep(remaining);
  }
};

async function finish() {
  if (finished) return;
  finished = true;
  stopped = true;
  // The last in-flight probe still counts: a short command must never be
  // reported as a "0.0 MB" success just because its final probe was running.
  if (pendingSample) {
    try { record(await pendingSample); } catch {}
  }
  if (termination) {
    try { await termination; } catch {}
  }
  try { await terminateTrackedDescendants(); } catch {}

  const observed = samples > 0
    ? `peak tree RSS ${mb(peakBytes)} MB from ${samples} sample(s)`
    : "no valid memory sample observed";
  log(`[memory-guard] ${label}: ${observed}, cap ${capMb} MB,`
    + ` minimum system free ${mb(minimumFreeBytes)} MB, reserve ${minFreeMb} MB`);

  const status = childExit ?? { code: null, signal: null };
  let verdict;
  let exitCode;
  if (systemPressure) {
    verdict = "system free-memory reserve exhausted";
    exitCode = 1;
  } else if (exceeded) {
    verdict = "memory cap exceeded";
    exitCode = 1;
  } else if (guardError) {
    verdict = guardError;
    exitCode = 1;
  } else if (samples === 0) {
    verdict = "the child was never observed by a memory probe";
    exitCode = 1;
  } else if (status.signal) {
    verdict = `child terminated by ${status.signal}`;
    exitCode = 1;
  } else {
    verdict = status.code === 0 ? "passed" : `child exited with code ${status.code}`;
    exitCode = status.code ?? 1;
  }
  if (exitCode !== 0) log(`[memory-guard] ${label}: FAILED — ${verdict}`);
  process.exit(exitCode);
}

child.on("error", (error) => {
  log(`[memory-guard] ${label}: failed to start — ${error.message}`);
  guardError ??= `child failed to start: ${error.message}`;
  childExit = { code: 127, signal: null };
  void finish();
});
child.on("exit", (code, signal) => {
  childExit = { code, signal };
  void finish();
});

for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (guardError) return;
    guardError = `interrupted by ${signal}`;
    log(`[memory-guard] ${label}: received ${signal} — terminating the test child`);
    stopped = true;
    void terminate().then(finish);
  });
}

void samplingLoop();
