// Version-directory garbage collection and daemon.log rotation, as server
// program source. GC runs only while the install lock is held, so every
// staging directory it finds belongs to a dead installer.

/** daemon.log is rotated past this size; one old generation is kept. */
export const REMOTE_LOG_MAX_BYTES = 5 * 1024 * 1024;

export const REMOTE_GC_SOURCE = String.raw`
const LOG_MAX_BYTES = ${REMOTE_LOG_MAX_BYTES};
/** Copy-then-truncate: the running daemon appends (O_APPEND) to the same
 *  descriptor and keeps writing at the new end. */
function rotateLog(file, maxBytes) {
  try {
    if (fs.statSync(file).size <= maxBytes) return false;
    fs.copyFileSync(file, file + '.1');
    fs.truncateSync(file, 0);
    return true;
  } catch { return false; }
}
/** Every process as { pid, command }, or null when they cannot be listed
 *  (GC then removes nothing and cleanup refuses: an unanswered probe is never
 *  evidence a tree is idle). */
function processList() {
  if (process.platform === 'linux') {
    try {
      const list = [];
      for (const name of fs.readdirSync('/proc')) {
        if (!/^\d+$/.test(name)) continue;
        try { list.push({ pid: Number(name), command: fs.readFileSync('/proc/' + name + '/cmdline', 'utf8').split('\0').join(' ').trim() }); } catch {}
      }
      return list;
    } catch { return null; }
  }
  // win32 only runs in the desktop's own unit tests (servers are POSIX).
  const run = process.platform === 'win32'
    ? cp.spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" }'], { encoding: 'utf8', timeout: 30000, windowsHide: true })
    : cp.spawnSync('ps', ['-axww', '-o', 'pid=,command='], { encoding: 'utf8', timeout: 5000 });
  if (run.status !== 0) return null;
  const list = [];
  for (const line of String(run.stdout).split(/\r?\n/)) {
    const match = /^\s*(\d+)\s?(.*)$/.exec(line);
    if (match) list.push({ pid: Number(match[1]), command: match[2].trim() });
  }
  return list;
}
function processCommandLines() {
  const list = processList();
  return list && list.map((entry) => entry.command);
}
/** Live processes (other than this one) running code from the install's
 *  versions or deps; null when the process list is unavailable. */
function installUsers(p) {
  const list = processList();
  if (!list) return null;
  const roots = [p.versions, p.deps];
  return list.filter((entry) => entry.pid !== process.pid && entry.command && roots.some((dir) => entry.command.includes(dir + '/') || entry.command.includes(dir + path.sep)));
}
function dropTree(dir) {
  const grave = path.join(path.dirname(dir), '.gc-' + path.basename(dir) + '-' + process.pid);
  try { fs.renameSync(dir, grave); } catch { return false; }
  removeTree(grave);
  return true;
}
/** Remove version dirs that are neither in keep (current, previous) nor used
 *  by a live process, leftovers of crashed installs, the pre-versioned
 *  layout (~/.mixdog-remote/<x.y.z>), and deps no remaining version links. */
function garbageCollect(p, keep, commands) {
  const removed = [];
  if (!commands) return { removed, skipped: 'process list unavailable' };
  const inUse = (dir) => commands.some((line) => line.includes(dir + '/') || line.includes(dir + path.sep));
  const list = (dir) => { try { return fs.readdirSync(dir); } catch { return []; } };
  const isDir = (dir) => { try { return fs.lstatSync(dir).isDirectory(); } catch { return false; } };
  for (const name of list(p.versions)) {
    const dir = path.join(p.versions, name);
    if (name.startsWith('.')) {
      if (/^\.(staging|gc)-/.test(name)) { removeTree(dir); removed.push('versions/' + name); }
      continue;
    }
    if (keep.has(name) || inUse(dir) || !isDir(dir)) continue;
    if (dropTree(dir)) removed.push('versions/' + name);
  }
  for (const name of list(p.root)) {
    const dir = path.join(p.root, name);
    if (/^\d+\.\d+\.\d+/.test(name) && isDir(dir) && !inUse(dir) && dropTree(dir)) removed.push(name);
  }
  const linked = new Set();
  for (const name of list(p.versions)) {
    try { linked.add(path.basename(path.dirname(fs.readlinkSync(path.join(p.versions, name, 'node_modules'))))); } catch {}
  }
  for (const name of list(p.deps)) {
    const dir = path.join(p.deps, name);
    if (name.startsWith('.')) {
      if (/^\.(staging|gc)-/.test(name)) { removeTree(dir); removed.push('deps/' + name); }
      continue;
    }
    if (linked.has(name) || inUse(dir) || !isDir(dir)) continue;
    if (dropTree(dir)) removed.push('deps/' + name);
  }
  return { removed, skipped: null };
}
`;
