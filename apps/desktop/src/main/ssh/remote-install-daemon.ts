// The server daemon's lifecycle, as server program source: read daemon.json
// and /health, decide reuse / replace / refuse, stop a proven Mixdog daemon
// (graceful /stop, then signals), pick a session port and spawn the daemon
// from the installed version directory.

// The graceful stop budget before SIGKILL is 20 s (the daemon's own shutdown
// budget is 15 s). The preferred session port is per user (41000 + uid % 20000)
// so an ssh forward stays valid across restarts; a busy one falls back to any
// free loopback port, and daemon.json stays the source of truth.
export const REMOTE_DAEMON_SOURCE = String.raw`
const daemonRequest = (port, token, method, route, body, timeoutMs) => new Promise((resolve) => {
  const payload = body === undefined ? null : JSON.stringify(body);
  const headers = { 'X-Mixdog-Daemon-Token': token };
  if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(payload); }
  const req = http.request({ host: '127.0.0.1', port, path: route, method, headers, timeout: timeoutMs || 1500 }, (res) => {
    let text = '';
    res.setEncoding('utf8');
    res.on('data', (chunk) => { text += chunk; });
    res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch {} resolve({ status: res.statusCode, json }); });
  });
  req.on('timeout', () => req.destroy(new Error('timeout')));
  req.on('error', () => resolve(null));
  req.end(payload || undefined);
});
async function readDaemonState(p) {
  let raw = null;
  try { raw = fs.readFileSync(p.discovery, 'utf8'); } catch {}
  let parsed = null;
  try { parsed = raw ? JSON.parse(raw) : null; } catch {}
  const session = parsed && parsed.endpoints && parsed.endpoints.session;
  const pid = Number(parsed && parsed.pid) || 0;
  const port = Number(session && session.port) || 0;
  const token = session && typeof session.token === 'string' ? session.token : '';
  const pidAlive = pid > 0 && alive(pid);
  let health = null;
  if (pidAlive && port && token) {
    const reply = await daemonRequest(port, token, 'GET', '/health');
    // Proof of ownership: the pid daemon.json names answers /health as itself.
    if (reply && reply.status === 200 && reply.json && reply.json.status === 'ok' && Number(reply.json.pid) === pid) health = reply.json;
  }
  return { raw, pid, port, token, pidAlive, health };
}
function daemonVersionOf(health) {
  return String((health && (health.packageVersion || health.version)) || '');
}
/** The /health modelProxy the desktop wants: 'client' (model calls come back
 *  to the PC) unless the saved server chose its own logins (null). */
function wantedModelProxy(want) {
  return want.modelLogin === 'server' ? null : 'client';
}
function daemonIsCurrent(health, want) {
  return Boolean(health) && (health.modelProxy || null) === wantedModelProxy(want) && health.buildHash === want.buildHash && daemonVersionOf(health) === want.version;
}
/** Same build, other model login mode: the only reason it is not current. */
function daemonModeDiffers(health, want) {
  return Boolean(health) && (health.modelProxy || null) !== wantedModelProxy(want) && health.buildHash === want.buildHash && daemonVersionOf(health) === want.version;
}
function daemonBusyCount(health) {
  const count = Number(health.busySessions != null ? health.busySessions : health.busy) || 0;
  if (health.idle === false) return Math.max(1, count);
  return count > 0 ? count : 0;
}
/** Views registered with the daemon (desktops, terminals): /health clients. */
function daemonClientCount(health) {
  return Math.max(0, Number(health.clients) || 0);
}
/** The version directory a daemon runs from, only when it is proven to be
 *  one this installer started: its command line runs daemon.mjs from
 *  ~/.mixdog-remote/versions/<id>/ and /health reports the build hash that
 *  directory's .install-complete marker names. Null for anything else. */
function managedInstallOf(p, state) {
  const buildHash = state.health && state.health.buildHash;
  if (!buildHash) return null;
  const command = processCommandLine(state.pid);
  if (!command) return null;
  const prefix = p.versions + path.sep;
  const at = command.indexOf(prefix);
  if (at < 0) return null;
  const installId = command.slice(at + prefix.length).split(path.sep)[0];
  if (!installId || !command.includes(path.join(p.versions, installId, 'src', 'standalone', 'daemon.mjs'))) return null;
  const marker = readJson(path.join(p.versions, installId, '.install-complete'));
  return marker && marker.buildHash === buildHash ? installId : null;
}
/** spawn: nothing runs; wait: a live pid not answering yet; reuse: current
 *  build in the wanted model login mode; unmanaged: not proven
 *  desktop-installed, never stopped; busy: another build (or the other mode)
 *  with running turns; attached: no turns but attached views (the desktop
 *  waits for their leases, then re-checks); replace: another
 *  desktop-installed build or mode, idle (or forced). Never attached to:
 *  a daemon whose mode differs from the saved choice. */
function decideDaemonAction(state, want, forceRestart, managed) {
  if (!state.pidAlive) return 'spawn';
  if (!state.health) return 'wait';
  if (daemonIsCurrent(state.health, want)) return 'reuse';
  if (!managed) return 'unmanaged';
  if (forceRestart) return 'replace';
  if (daemonBusyCount(state.health) > 0) return 'busy';
  if (daemonClientCount(state.health) > 0) return 'attached';
  return 'replace';
}
function busyDaemonMessage(state, want) {
  const health = state.health || {};
  const count = daemonBusyCount(health);
  const clients = daemonClientCount(health);
  const doing = [];
  if (count > 0) doing.push('is running ' + count + ' turn' + (count === 1 ? '' : 's'));
  if (clients > 0) doing.push('has ' + clients + ' attached client' + (clients === 1 ? '' : 's'));
  const which = want && daemonModeDiffers(health, want)
    ? 'A Mixdog daemon using ' + (health.modelProxy === 'client' ? "this PC's" : "the server's") + ' model logins'
    : 'A Mixdog daemon of another version';
  return which + ' (mixdog ' + (daemonVersionOf(health) || 'unknown') +
    (health.buildHash ? ' build ' + health.buildHash : '') + ', pid ' + state.pid + ') ' + (doing.join(' and ') || 'is in use') +
    ' on the server. Wait for it to finish, or restart it anyway (its running turns stop and attached clients disconnect).';
}
function unmanagedDaemonMessage(state) {
  const health = state.health || {};
  return 'A Mixdog daemon the desktop did not install (pid ' + state.pid + ', mixdog ' + (daemonVersionOf(health) || 'unknown') +
    ') holds the desktop session record on the server. The desktop never stops it; stop it on the server, then reconnect.';
}
/** Defensive: the desktop daemon has its own data directory, so a live owner
 *  there that is not the recorded daemon is something else entirely; the
 *  daemon would lose the single-owner lock to it. */
function assertDataOwnerFree(p, state) {
  const owner = readJson(p.dataOwner);
  const pid = Number(owner && owner.pid) || 0;
  if (!(pid > 0) || pid === state.pid || pid === process.pid || !alive(pid)) return;
  fail('daemon-data-in-use', 'Another Mixdog daemon (pid ' + pid + ') that the desktop did not start is using ' + path.dirname(p.dataOwner) +
    ' on the server. The desktop leaves it running; stop it on the server, then reconnect.');
}
async function waitForExit(pid, ms) {
  const until = Date.now() + ms;
  while (alive(pid)) {
    if (Date.now() > until) return false;
    await sleep(100);
  }
  return true;
}
async function terminateProcess(pid, graceMs) {
  try { process.kill(pid, 'SIGTERM'); } catch {}
  if (await waitForExit(pid, graceMs)) return { killed: false };
  try { process.kill(pid, 'SIGKILL'); } catch {}
  if (await waitForExit(pid, 5000)) return { killed: true };
  fail('daemon-stop', 'The Mixdog daemon (pid ' + pid + ') did not exit after SIGKILL.');
}
/** Only for a state whose health proved the pid: authenticated /stop first,
 *  then SIGTERM (a daemon without /stop), then SIGKILL past the grace. */
async function stopDaemon(state, options) {
  const force = options.force === true;
  const graceMs = Number(options.graceMs) || 20000;
  const reply = await daemonRequest(state.port, state.token, 'POST', '/stop', { force, reason: options.reason || 'replaced by the desktop' }, 3000);
  if (reply && reply.status === 409 && !force) fail('daemon-busy-other-version', busyDaemonMessage(state, options.want));
  const accepted = Boolean(reply && reply.status === 200);
  if (accepted && await waitForExit(state.pid, graceMs)) return { pid: state.pid, graceful: true, killed: false };
  const result = await terminateProcess(state.pid, accepted ? 2000 : graceMs);
  return { pid: state.pid, graceful: false, killed: result.killed };
}
/** The pid's command line, or null when it cannot be read. */
function processCommandLine(pid) {
  if (process.platform === 'linux') {
    try { return fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8').split('\0').join(' ').trim(); } catch { return null; }
  }
  // win32 only runs in the desktop's own unit tests (servers are POSIX).
  const run = process.platform === 'win32'
    ? cp.spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(Get-CimInstance Win32_Process -Filter "ProcessId=' + Number(pid) + '").CommandLine'], { encoding: 'utf8', timeout: 15000, windowsHide: true })
    : cp.spawnSync('ps', ['-ww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8', timeout: 5000 });
  return run.status === 0 ? String(run.stdout).trim() : null;
}
const portFree = (port) => new Promise((resolve) => {
  const server = net.createServer();
  server.once('error', () => resolve(false));
  server.listen({ host: '127.0.0.1', port, exclusive: true }, () => server.close(() => resolve(true)));
});
const anyFreePort = () => new Promise((resolve) => {
  const server = net.createServer();
  server.once('error', () => resolve(0));
  server.listen({ host: '127.0.0.1', port: 0, exclusive: true }, () => { const port = server.address().port; server.close(() => resolve(port)); });
});
/** The preferred port when free, else any free loopback port. */
async function chooseSessionPort(preferred, avoid) {
  if (preferred && !avoid.has(preferred) && await portFree(preferred)) return preferred;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const port = await anyFreePort();
    if (port && !avoid.has(port)) return port;
  }
  fail('port-unavailable', 'No free loopback port for the Mixdog session service on the server (preferred ' + preferred + ' is in use).');
}
function readLogFrom(file, offset) {
  try {
    const data = fs.readFileSync(file);
    return data.subarray(Math.min(offset, data.length)).toString('utf8');
  } catch { return ''; }
}
function logTail(text) {
  return String(text).split('\n').filter(Boolean).slice(-8).join(' | ') || '(no log output)';
}
function spawnDaemon(p, args, versionDir, port) {
  fs.mkdirSync(p.root, { recursive: true });
  for (const dir of [p.runtimeRoot, p.userData, p.mixdogHome, p.dataDir]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
  }
  rotateLog(p.log, LOG_MAX_BYTES);
  fs.appendFileSync(p.log, '\n[mixdog-remote] ' + new Date().toISOString() + ' starting ' + args.installId + ' port=' + port + '\n');
  const logOffset = fs.statSync(p.log).size;
  const log = fs.openSync(p.log, 'a');
  const env = Object.assign({}, process.env, {
    MIXDOG_DAEMON_HOST: '1',
    MIXDOG_DAEMON_SPAWNED_FOR: 'session',
    MIXDOG_MODEL_PROXY: 'client',
    MIXDOG_SESSION_PORT: String(port),
    MIXDOG_RUNTIME_ROOT: p.runtimeRoot,
    // Everything that defaults to ~/.mixdog: never the user's own install's.
    MIXDOG_HOME: p.mixdogHome,
    MIXDOG_CONFIG_DIR: p.mixdogHome,
    MIXDOG_DATA_DIR: p.dataDir,
  });
  // The server's own logins (the saved server's opt-in): no model proxy, not
  // even one the ssh session's environment would pass on.
  if (args.modelLogin === 'server') delete env.MIXDOG_MODEL_PROXY;
  // Read by the daemon at start only: a changed per-server grace setting
  // applies from the next daemon start.
  if (args.graceMs) env.MIXDOG_REMOTE_CLIENT_GRACE_MS = String(args.graceMs);
  // detached = setsid: the daemon leaves this ssh session and survives it.
  const child = cp.spawn(process.execPath, [path.join(versionDir, 'src', 'standalone', 'daemon.mjs')], { cwd: os.homedir(), detached: true, windowsHide: true, stdio: ['ignore', log, log], env });
  fs.closeSync(log);
  const record = { child, port, logOffset, exit: null };
  child.once('exit', (code, signal) => { record.exit = { at: Date.now(), code, signal }; });
  child.unref();
  return record;
}
async function ensureDaemon(p, args, versionDir, uid) {
  const want = { version: args.version, buildHash: args.buildHash, modelLogin: args.modelLogin };
  const forceRestart = args.forceRestart === true;
  const preferred = 41000 + (uid % 20000);
  const triedPorts = new Set();
  const startedAt = Date.now();
  let candidate = null;
  let replaced = null;
  let replacements = 0;
  for (;;) {
    const state = await readDaemonState(p);
    const managed = state.health && !daemonIsCurrent(state.health, want) ? managedInstallOf(p, state) : null;
    const action = decideDaemonAction(state, want, forceRestart, managed);
    if (action === 'reuse') return { state, started: Boolean(candidate), replaced };
    if (action === 'unmanaged') fail('daemon-unmanaged', unmanagedDaemonMessage(state));
    if (action === 'busy') fail('daemon-busy-other-version', busyDaemonMessage(state, want));
    if (action === 'attached') fail('daemon-clients-attached', busyDaemonMessage(state, want));
    if (action === 'replace') {
      if (replacements >= 2) fail('daemon-replace', 'Another Mixdog daemon (pid ' + state.pid + ', mixdog ' + daemonVersionOf(state.health) + ') keeps taking the session service on the server.');
      replacements += 1;
      const stopped = await stopDaemon(state, { force: forceRestart, want });
      replaced = { pid: state.pid, version: daemonVersionOf(state.health), buildHash: state.health.buildHash || null, modelProxy: state.health.modelProxy || null, graceful: stopped.graceful };
      continue;
    }
    if (candidate && candidate.exit && Date.now() - candidate.exit.at > 1000 && !state.pidAlive) {
      const output = readLogFrom(p.log, candidate.logOffset);
      if (/MIXDOG_SESSION_PORT\) is unavailable|EADDRINUSE/.test(output) && triedPorts.size < 4) {
        candidate = null;
      } else {
        fail('daemon-exited', 'The Mixdog daemon exited on the server (status ' + candidate.exit.code + '). ' + p.log + ': ' + logTail(output));
      }
    }
    // A live pid that never answers is either still booting or a reused pid:
    // after a grace the singleton lock decides between it and a new candidate.
    if (!candidate && (action === 'spawn' || Date.now() - startedAt > 10000)) {
      assertDataOwnerFree(p, state);
      const port = await chooseSessionPort(preferred, triedPorts);
      triedPorts.add(port);
      candidate = spawnDaemon(p, args, versionDir, port);
    }
    if (Date.now() - startedAt > 45000) {
      fail('daemon-timeout', 'The Mixdog daemon did not become ready on the server. ' + p.log + ': ' + logTail(readLogFrom(p.log, candidate ? candidate.logOffset : 0)));
    }
    await sleep(250);
  }
}
/** Stop the desktop-managed daemon for a cleanup: only a pid that runs
 *  daemon.mjs from ~/.mixdog-remote/versions (its /health, when it answers as
 *  the daemon.json pid, gets the graceful /stop). */
async function stopOwnedDaemon(p) {
  const state = await readDaemonState(p);
  if (!state.pidAlive) {
    if (state.raw) { try { fs.rmSync(p.discovery, { force: true }); } catch {} }
    return null;
  }
  const command = processCommandLine(state.pid);
  const fromInstall = command != null && command.includes(p.versions + path.sep) && /daemon\.mjs/.test(command);
  if (!fromInstall) return { pid: state.pid, stopped: false, reason: 'not-proven' };
  const result = state.health ? await stopDaemon(state, { force: true, reason: 'server cleanup' }) : await terminateProcess(state.pid, 20000);
  return { pid: state.pid, stopped: true, killed: result.killed === true };
}
`;
