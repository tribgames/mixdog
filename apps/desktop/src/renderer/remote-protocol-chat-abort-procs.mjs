// The processes a recorded case leaves, found and ended with proof (Windows): every descendant of the case's daemon (an orphan keeps its
// parent's pid, so the tree is found after the daemon exited) and every process whose command line names the case's folder. The
// recording process's own helpers (Node's ACL helper, file-permissions.mjs:85-91, runs from System32 for the process's life) are not the
// case's and are left alone. One CIM query lists them; `Stop-Process` ends them and `Wait-Process` (the OS's own wait, with
// its timeout as the deadline) waits for their exit; a second query proves none is left, or the call fails naming each survivor.
import { spawnSync } from 'node:child_process';

const MARK = 'mixdog-abort-procs-query';

function powershell(script, what) {
  const out = spawnSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8', timeout: 120_000, maxBuffer: 1 << 26 });
  if (out.status !== 0) throw new Error(`${what} failed (${out.status ?? out.error}): ${out.stderr}`);
  return out.stdout;
}

/** Every process now: pid, parent, name, command line (the query's own powershell is left out by its marker). */
export function allProcesses() {
  const text = powershell(`# ${MARK}\nGet-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine | ConvertTo-Json -Compress`, 'listing the processes');
  return JSON.parse(text).filter((p) => !(p.CommandLine ?? '').includes(MARK));
}

/** The processes a case may have left: descendants of `rootPid` (the case's daemon) and any whose command line names `folder`. */
export function leftBy(rootPid, folder, processes = allProcesses()) {
  const children = new Map();
  for (const p of processes) children.set(p.ParentProcessId, [...(children.get(p.ParentProcessId) ?? []), p]);
  const found = new Map();
  const walk = (pid) => { for (const child of children.get(pid) ?? []) if (!found.has(child.ProcessId)) { found.set(child.ProcessId, child); walk(child.ProcessId); } };
  walk(rootPid);
  const forms = [folder, folder.replaceAll('\\', '/')].map((f) => f.toLowerCase());
  for (const p of processes) if (forms.some((f) => (p.CommandLine ?? '').toLowerCase().includes(f))) found.set(p.ProcessId, p);
  found.delete(rootPid);
  return [...found.values()];
}

/** Ends everything `leftBy` finds and proves it ended; returns what had been left (for the report), [] when nothing was. */
export function endLeftovers(rootPid, folder) {
  const left = leftBy(rootPid, folder);
  if (!left.length) return [];
  const ids = left.map((p) => p.ProcessId).join(',');
  process.stderr.write(`left running: ${left.map((p) => `${p.ProcessId} ${p.Name} ${p.CommandLine}`).join(' | ')}\n`);
  // A process that already exited between the listing and the stop is no error; the second listing is the proof either way.
  powershell(`# ${MARK}\n$ids = @(${ids}); Stop-Process -Id $ids -Force -ErrorAction SilentlyContinue; Wait-Process -Id $ids -Timeout 60 -ErrorAction SilentlyContinue; exit 0`, `ending ${ids}`);
  const still = leftBy(rootPid, folder).filter((p) => left.some((q) => q.ProcessId === p.ProcessId));
  if (still.length) throw new Error(`processes left by the case did not end within 60 s: ${still.map((p) => `${p.ProcessId} ${p.Name} ${p.CommandLine}`).join('; ')}`);
  return left.map((p) => ({ pid: p.ProcessId, name: p.Name, commandLine: p.CommandLine }));
}
