// Records what the app's quit does to a new task in flight on Node b6f10295a, with Node's real daemon and its desktop service (the SessionHost runs
// in the daemon, as the app's does), and what the same request does when it comes in again after the app started again
// (new-task-quit/world.mjs, one process per case, each with its own daemon, data folders and ports). The cases (new-task-quit/cases.mjs) are
// independent and run four at a time; the whole recording runs twice and the two runs must agree once the random addresses are numbered.
//
//   record:  node benchmarks/rust-core/recorders/record-new-task-quit.mjs --tree <exact export of b6f10295a with node_modules> [--only <case>]
//   replay:  node --import tsx ../../benchmarks/rust-core/recorders/record-new-task-quit.mjs --tree <same> --replay <mixdogd.exe built with --features crash-gates> [--only <case>]
//            (cwd: apps/desktop)
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { FIXTURES_ROOT, REPO_ROOT, exactProductIdentity, parseArgs, resolveTree, stableStringify, writeSetManifest, writeText } from './lib/common.mjs';
import { CASES, COMPARISON, caseRoot, numberFresh } from './new-task-quit/cases.mjs';

const COMMIT = 'b6f10295a2f698afc85332467192de28500bd146';
const WORK = 'D:\\mixdog-build\\tmp\\new-task-quit\\build';
const SET_DIR = join(FIXTURES_ROOT, 'new-task-quit');
const SUPERVISOR = 'D:\\mixdog-build\\tmp\\real-turn-harness\\cache\\supervisor-v0.1.1\\mixdog-supervisor-win32-x64.exe';
const AT_ONCE = 4;
const args = parseArgs();
const tree = resolveTree(args);
const here = join(REPO_ROOT, 'benchmarks', 'rust-core', 'recorders');
const only = args.get('only') ?? null;
const chosen = CASES.filter((c) => !only || c.name === only);
if (!chosen.length) throw new Error(`--only names no case: ${only}`);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Runs `n` tasks at most `AT_ONCE` at a time; resolves with their results in order. */
async function inGroups(tasks) {
  const results = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) {
      const index = next++;
      results[index] = await tasks[index]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(AT_ONCE, tasks.length) }, worker));
  return results;
}

/** Every process whose command line names `folder`, ended (a case's daemon, supervisor and git, if any outlived the case). */
function endLeftovers(folder) {
  const script = `$f = '${folder.replaceAll("'", "''")}'.ToLower(); $left = @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains($f) -and $_.ProcessId -ne $PID }); foreach ($p in $left) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }; if ($left.Count) { Wait-Process -Id ($left.ProcessId) -Timeout 60 -ErrorAction SilentlyContinue }; $left | ForEach-Object { "$($_.ProcessId) $($_.Name)" }`;
  return execFileSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8', timeout: 120_000 }).trim();
}

/** The service the daemon loads (`daemon.cjs`), built from the export by the app's own build script, and the `git` the daemons run first. */
function prepare(run) {
  const root = join(WORK, run);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, 'bin'), { recursive: true });
  const serviceModule = join(root, 'svc', 'out', 'main', 'daemon.cjs');
  execFileSync(process.execPath, [join(tree, 'apps', 'desktop', 'scripts', 'build-daemon.mjs'), `--outfile=${serviceModule}`], { cwd: join(tree, 'apps', 'desktop'), stdio: 'pipe', timeout: 600_000 });
  const shim = join(root, 'bin', 'git.exe');
  const source = join(here, 'new-task-quit', 'git-shim.cs');
  execFileSync('powershell.exe', ['-NoProfile', '-Command', `Add-Type -TypeDefinition ([IO.File]::ReadAllText('${source}')) -OutputAssembly '${shim}' -OutputType ConsoleApplication`], { stdio: 'pipe', timeout: 300_000 });
  if (!existsSync(shim)) throw new Error(`the git shim was not compiled to ${shim}`);
  return { root, serviceModule, shimDir: join(root, 'bin'), service: sha256(readFileSync(serviceModule)) };
}

/** One case in its own process; a case that does not end within 240 s is ended with what it started. */
function recordCase(prepared, c) {
  // The same folder on every run and in the replay: the task's project path is part of the request (and of its receipt's signature).
  const root = caseRoot(c);
  const out = join(prepared.root, `${c.name}.json`);
  const spec = { ...c, root, shimDir: prepared.shimDir, supervisor: SUPERVISOR, serviceModule: prepared.serviceModule };
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', join(here, 'new-task-quit', 'world.mjs'), tree, JSON.stringify(spec), out], { cwd: join(tree, 'apps', 'desktop'), stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill(), 240_000);
    child.once('exit', (code) => {
      clearTimeout(timer);
      const left = endLeftovers(root);
      let result = null;
      try {
        result = JSON.parse(readFileSync(out, 'utf8'));
      } catch {}
      if (code !== 0 || !result || result.failure) return reject(new Error(`${c.name}: exit ${code}${left ? `, left running: ${left}` : ''}\n${result?.failure ?? ''}\n${stderr.slice(-4000)}`));
      if (left) return reject(new Error(`${c.name}: processes outlived the case: ${left}`));
      rmSync(root, { recursive: true, force: true });
      resolve(result.recorded.steps);
    });
  });
}

const recordAll = async (run) => {
  const prepared = prepare(run);
  const started = Date.now();
  const steps = await inGroups(chosen.map((c) => () => recordCase(prepared, c)));
  console.log(`${run}: ${chosen.length} cases in ${Math.round((Date.now() - started) / 1000)} s`);
  return { prepared, recorded: Object.fromEntries(chosen.map((c, i) => [c.name, steps[i]])) };
};

if (!args.get('replay')) {
  const first = await recordAll('run-1');
  const second = await recordAll('run-2');
  if (first.prepared.service !== second.prepared.service) throw new Error('the two builds of daemon.cjs differ');
  const golden = {};
  const random = [];
  for (const c of chosen) {
    const a = numberFresh(c, first.recorded[c.name]);
    const b = numberFresh(c, second.recorded[c.name]);
    if (stableStringify(a) !== stableStringify(b)) throw new Error(`${c.name}: two recordings differ beyond the random addresses:\n${stableStringify(a)}\n${stableStringify(b)}`);
    if (stableStringify(first.recorded[c.name]) !== stableStringify(second.recorded[c.name])) random.push(c.name);
    golden[c.name] = { case: c, recorded: a };
  }
  if (!only) {
    writeText(join(SET_DIR, 'golden.json'), stableStringify({ cases: golden }));
    writeSetManifest(SET_DIR, {
      set: 'new-task-quit',
      recorder: 'benchmarks/rust-core/recorders/record-new-task-quit.mjs',
      command: 'node benchmarks/rust-core/recorders/record-new-task-quit.mjs --tree <exact export of b6f10295a with node_modules>',
      identity: exactProductIdentity(tree, COMMIT),
      extra: {
        desktopService: {
          module: 'daemon.cjs built from the export by apps/desktop/scripts/build-daemon.mjs (its scripts/ and package-lock.json taken from the commit with git archive); the daemon loads it as the app names it (index.ts:467-485, desktop-service-registry.mjs:111-205)',
          sha256: first.prepared.service,
        },
        random: {
          'fresh session address': 'a session address after a refusal reset is `sess_desktop_` + 32 random bytes in hex (freshSessionId, new-task-requests.ts:85); numbered `<fresh:N>` by first appearance in a case',
          casesWhereTheTwoRunsDiffered: random,
        },
        quit: {
          sequence:
            "the app's own (index.ts:1634-1725 disposeDesktopResources): the carriers and the local connection are detached first (index.ts:1662-1665, 1684-1685; desktop-connection.ts:513-523 `client.dispose()`, which rejects the app's pending calls with `Mixdog desktop service client is disposed.`), then `transport.stopInTreeDaemon(DESKTOP_DAEMON_STOP_TIMEOUT_MS)` (index.ts:1710-1712) sends `POST /stop {force:true}` (session-client.mjs:667-707) to the daemon this process forked into its tree (`process.type` browser on win32, session-client.mjs:59-63); the route answers, then raises SIGTERM (routes.mjs:200-209, 40-43) and the daemon's `shutdown` runs to `process.exit` (daemon.mjs:272-413) without `drainDeferral` (consulted by the self-shutdown only, daemon.mjs:506-566)",
          heldCallReleased: 'once the daemon answered the stop request: the held call settles while the daemon shuts down (the session service is closed first, session-service.mjs:257; the host is disposed, session-host.ts:1208-1229)',
          outstandingAtExit:
            "Node's other outcome, the call still outstanding at `process.exit` (daemon.mjs:412): nothing rejects it (the in-process bridge rejects only on an abort signal, daemon-local-session-bridge.mjs:32-51, and the host passes none, session-host-transport.ts:202), so the attempt ends where it stands, as a kill does there: the new-task-dedupe set's `crash` scenarios record that state, and both exist for that reason",
          notHeld: 'create, setWorkflow and setOrchestrationMode wait on nothing outside the daemon (cases.mjs): a quit there is the kill at that point',
        },
        comparison: COMPARISON,
      },
    });
  }
  if (only) console.log(stableStringify(golden));
  console.log(`recorded ${chosen.length} cases twice; ${random.length} contain a random address`);
} else {
  const { replayNewTaskQuit } = await import('./new-task-quit/replay.mjs');
  const golden = JSON.parse(readFileSync(join(SET_DIR, 'golden.json'), 'utf8')).cases;
  process.exit(await replayNewTaskQuit({ exe: args.get('replay'), cases: chosen, golden }));
}
