// One recorded case of a `session` tool send on Node b6f10295a run unchanged, in the app's own process layout (as new-task-quit/world.mjs):
// this process is the app's main process, its local connection the app's `DesktopServiceClient` over a `SessionTransport`, and the daemon
// it starts loads the desktop service the app names (`daemon.cjs`), so the session service, the agent task sessions, the report home store
// and the group-room host are Node's own. The only stand-in is the model endpoint (cases.mjs `answerOf`): a turn's answer comes from the
// case's script, by what the turn's request asks.
//
//   node --import tsx world.mjs <export dir> <case json file> <out file>      (cwd: <export dir>/apps/desktop)
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createModel, prepareData, runSteps } from './cases.mjs';

const [exportDir, caseFile, outFile] = process.argv.slice(2);
const c = JSON.parse(readFileSync(caseFile, 'utf8'));
const root = c.root;
const paths = {
  home: join(root, 'home'),
  dataDir: join(root, 'home', '.mixdog', 'data'),
  mixdogHome: join(root, 'home', '.mixdog'),
  runtimeRoot: join(root, 'runtime'),
  appData: join(root, 'home', 'AppData', 'Roaming'),
  localAppData: join(root, 'home', 'AppData', 'Local'),
  tmp: join(root, 'tmp'),
  workspace: join(root, 'ws'),
};
// The app's user-data folder is where the core keeps its own (`<data>/userdata` of the replay's core, replay.mjs): a path either side
// shows (the unclassified workspace, cut short in a row's preview) is then the same text.
const userData = join(root, 'core', 'data', 'userdata');
for (const dir of [...Object.values(paths), userData]) mkdirSync(dir, { recursive: true });

const model = createModel(c);
const provider = http.createServer((req, res) => model.serve(req, res));
await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
const baseURL = `http://127.0.0.1:${provider.address().port}/v1`;

const DROP = /^(MIXDOG_|HTTPS?_PROXY$|ALL_PROXY$|NO_PROXY$|OPENAI_|ANTHROPIC_|GOOGLE_|GEMINI_|AZURE_|XDG_|ELECTRON_)/i;
for (const name of Object.keys(process.env)) if (DROP.test(name)) delete process.env[name];
Object.assign(process.env, {
  MIXDOG_DATA_DIR: paths.dataDir,
  MIXDOG_HOME: paths.mixdogHome,
  MIXDOG_CONFIG_DIR: paths.mixdogHome,
  MIXDOG_DESKTOP_USER_DATA: userData,
  MIXDOG_RUNTIME_ROOT: paths.runtimeRoot,
  MIXDOG_SKIP_USER_DATA_BACKUP: '1',
  MIXDOG_SUPERVISOR_BIN: c.supervisor,
  MIXDOG_DAEMON_SKIP_MEMORY: '1',
  // A session still starts the shared memory runtime (detached, with its Postgres); it ends once idle this long instead of 10 minutes, so a
  // case ends with nothing of it left running.
  MIXDOG_MEMORY_IDLE_TTL_MS: '3000',
  MIXDOG_DISABLE_MCP: '1',
  HOME: paths.home,
  USERPROFILE: paths.home,
  APPDATA: paths.appData,
  LOCALAPPDATA: paths.localAppData,
  TEMP: paths.tmp,
  TMP: paths.tmp,
  TMPDIR: paths.tmp,
  NO_PROXY: '127.0.0.1,localhost',
  ...c.env,
});
prepareData(paths.dataDir, baseURL, c);

Object.defineProperty(process, 'type', { value: 'browser', configurable: true });
const load = (path) => import(pathToFileURL(join(exportDir, path)).href);
const { DesktopServiceClient } = await load('apps/desktop/src/main/desktop-service-client.ts');
const { SessionTransport } = await load('apps/desktop/src/main/session-transport.ts');
const { DESKTOP_DAEMON_STOP_TIMEOUT_MS } = await load('apps/desktop/src/main/quit-sequence.ts');
// The daemon inherits these flags (session-client.mjs `execArgv`): its clock and uuids are the case's script (daemon-clock.mjs).
process.execArgv = ['--import', pathToFileURL(join(import.meta.dirname, 'daemon-clock.mjs')).href];
const moduleUrl = pathToFileURL(c.serviceModule).href;

/** The daemon's pid, from its discovery file in the runtime root (the kill ends its process tree). */
function daemonPid() {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const at = join(dir, entry.name);
      if (entry.isDirectory()) walk(at);
      else if (/\.json$/.test(entry.name)) {
        try {
          const pid = Number(JSON.parse(readFileSync(at, 'utf8'))?.pid);
          if (pid > 0) found.push(pid);
        } catch {}
      }
    }
  };
  if (existsSync(paths.runtimeRoot)) walk(paths.runtimeRoot);
  return [...new Set(found)];
}

/** Node's side of a case's driver (cases.mjs `runSteps`): the app's client calls. */
function nodeApp() {
  let client = null;
  let transport = null;
  const states = new Map();
  const shown = [];
  const open = async (within) => {
    client = new DesktopServiceClient({
      // The app's own 15 s startup limit is under what the daemon's start takes on this PC while other builds run (20 s seen): the
      // step's deadline below bounds it instead.
      startupTimeoutMs: 120_000,
      connect: () => (transport = new SessionTransport(moduleUrl, paths.workspace, null, Promise.resolve(), null)),
      sessionOptions: () => ({ userDataPath: userData, packaged: false, resourcesPath: join(exportDir, 'apps', 'desktop'), appPath: join(exportDir, 'apps', 'desktop') }),
    });
    // A window opened again knows nothing of what the one before it was shown.
    states.clear();
    await within(120_000, client.start(), 'the app to attach to its daemon');
    client.subscribeSessionStates((update) => {
      if (!update?.sessionId || !update.snapshot) return;
      states.set(update.sessionId, update.snapshot);
      shown.push({ sessionId: update.sessionId, snapshot: update.snapshot });
      model.stir();
    });
  };
  return {
    side: 'node',
    open,
    async quit(within) {
      await within(60_000, client.dispose(), 'the local connection to dispose');
      const outcome = await within(120_000, transport.stopInTreeDaemon(DESKTOP_DAEMON_STOP_TIMEOUT_MS), 'the in-tree daemon to stop');
      for (const pid of outcome.stopped ? [] : outcome.inTree) spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { timeout: 60_000, windowsHide: true });
    },
    // The process ended from outside (a crash, a killed process): nothing of it runs its own stop, so no report of it is sent then.
    async kill(within) {
      for (const pid of daemonPid()) spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { timeout: 60_000, windowsHide: true });
      await within(60_000, client.dispose(), 'the local connection to dispose');
    },
    openHome: async (agentId) => (await client.openAgentHome(agentId)).sessionId,
    newTask: async (prompt, id) => (await client.submitNewTask(prompt, { displayText: prompt, id }, { route: { provider: 'custom-harness', model: 'harness-model' } })).sessionId,
    say: (sessionId, prompt, options = {}) => client.submitToSession(sessionId, prompt, { displayText: prompt, ...options }),
    userData,
    watch: (ids) => client.setVisibleSessions(ids),
    busy: (sessionId) => states.get(sessionId)?.busy === true,
    snapshot: (sessionId) => states.get(sessionId) ?? null,
    read: (sessionId) => client.readSessionTranscript(sessionId),
    abort: (sessionId) => client.abortSession(sessionId),
    remove: (sessionId) => client.deleteSession(sessionId),
    archive: (sessionId, archived) => client.setSessionArchived(sessionId, archived),
    approve: (sessionId, id, decision) => client.resolveToolApprovalForSession(sessionId, id, decision),
    room: (action, args) => client.agentRoomAction(action, args),
    capability: async (name, args, sessionId) => (await client.invokeCapability(name, args, sessionId)).value ?? null,
    // The room host's store (agent-rooms.ts `createAgentRoomFileStore`, `<userData>/agent-rooms.json`).
    roomRecords: async () => (existsSync(join(userData, 'agent-rooms.json')) ? JSON.parse(readFileSync(join(userData, 'agent-rooms.json'), 'utf8')).rooms : {}),
    shown,
    files: () => paths.dataDir,
  };
}

let failure = null;
let recorded = null;
try {
  recorded = await runSteps(c, nodeApp(), model);
} catch (error) {
  failure = error;
} finally {
  provider.close();
  provider.closeAllConnections();
}
// The daemon's memory runtime stops its Postgres (run from this case's data folder) on its own after the app quits: the case ends once
// nothing runs from its folders (or was started by a process that does, as Postgres's workers) any more, within a deadline; what still runs then is written as the evidence of the job's leftover.
const onRoot = () =>
  spawnSync('powershell', ['-NoProfile', '-Command', `$all = Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -notin @(${process.pid}, ${process.ppid}, $PID) }; $on = @{}; foreach ($p in $all) { if ($p.CommandLine -like '*${root.replaceAll("'", "''")}*') { $on[[int]$p.ProcessId] = $true } }; do { $n = $on.Count; foreach ($p in $all) { if ($on.ContainsKey([int]$p.ParentProcessId)) { $on[[int]$p.ProcessId] = $true } } } while ($on.Count -ne $n); $all | Where-Object { $on.ContainsKey([int]$_.ProcessId) } | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.CommandLine)" }`], { encoding: 'utf8', timeout: 60_000, windowsHide: true }).stdout.trim();
// On a loaded machine the memory runtime's own stop can outlast the deadline: the case then stops the database it started, as its owner
// does, with the runtime's own `pg_ctl` (a fast stop waits for every worker to end).
const pgdata = join(paths.dataDir, 'pgdata');
const pgRuntime = existsSync(join(paths.dataDir, 'runtime')) ? readdirSync(join(paths.dataDir, 'runtime')).find((name) => name.startsWith('runtime-pg')) : null;
if (pgRuntime && existsSync(join(pgdata, 'postmaster.pid'))) {
  spawnSync(join(paths.dataDir, 'runtime', pgRuntime, 'bin', 'pg_ctl.exe'), ['stop', '-D', pgdata, '-m', 'fast', '-w', '-t', '60'], { timeout: 90_000, windowsHide: true });
}
const settledBy = Date.now() + 60_000;
let running = onRoot();
while (running && Date.now() < settledBy) {
  await new Promise((resolve) => setTimeout(resolve, 1000));
  running = onRoot();
}
if (running) process.stderr.write(`running from the case's folders 60 s after its end:\n${running}\n`);
writeFileSync(outFile, JSON.stringify({ recorded, trace: model.trace, failure: failure ? String(failure.stack ?? failure) : null, ...(failure ? { requests: model.requests, shown: failure.shown ?? null } : {}) }, null, 2));
process.exit(failure ? 1 : 0);
