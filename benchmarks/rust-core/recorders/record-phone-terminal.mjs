#!/usr/bin/env node
// What the phone's terminal and folder-watch calls and pushes answer at the Node baseline (b6f10295a): the real remote methods
// (`createRemoteMethods` and `executeRemoteFrame`, the frame a phone sends), over the real desktop operations (a real TerminalManager
// on a scripted PTY, the real shell-profile detection and folder-watch registry), with the real relay push lanes projecting the
// events. The script is lib/phone-terminal-script.mjs; apps/mobile replays it through the protocol adapter against a built mixdogd.
//
//   node --import <apps/desktop/scripts/test-env.mjs> --import <apps/desktop/scripts/test-tsx.mjs> --import lib/fake-pty-register.mjs \
//        benchmarks/rust-core/recorders/record-phone-terminal.mjs --tree <git archive of b6f10295a with node_modules>
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { REPO_ROOT, commitStage, exactProductIdentity, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';
import { mock } from 'node:test';
import { play, sizeClaimScript, terminalScript } from './lib/phone-terminal-script.mjs';

const REF = 'b6f10295a2f698afc85332467192de28500bd146';
const ROOT = 'D:\\mixdog-build\\tmp\\ph2-terminal';
const CONNECTION = 'conn-1';
const args = parseArgs();
const tree = resolveTree(args);

if (!args.has('child')) {
  // The PTY module is replaced by a loader hook, which only a fresh process can take.
  const here = fileURLToPath(import.meta.url);
  const hook = (rel) => pathToFileURL(join(REPO_ROOT, rel)).href;
  const child = spawnSync(
    process.execPath,
    [
      '--import', hook('apps/desktop/scripts/test-env.mjs'),
      '--import', hook('apps/desktop/scripts/test-tsx.mjs'),
      '--import', hook('benchmarks/rust-core/recorders/lib/fake-pty-register.mjs'),
      here, '--tree', tree, '--child',
    ],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
  );
  const at = child.stdout.lastIndexOf('@@TRACE@@');
  if (child.status !== 0 || at < 0) throw new Error(`recording failed (${child.status}):\n${child.stdout.slice(-2000)}\n${child.stderr.slice(-4000)}`);
  const trace = JSON.parse(child.stdout.slice(at + '@@TRACE@@'.length));
  const finalOut = join(REPO_ROOT, 'apps', 'mobile', 'fixtures', 'phone-terminal');
  const out = stageSet(finalOut);
  writeJson(join(out, 'golden.json'), {
    note: 'Node terminal and folder-watch calls and pushes as a phone sees them: per call its answer or error text, per push kind the events its listeners got, in order. Shell text is reduced to the facts the script controls.',
    root: ROOT,
    trace,
  });
  writeSetManifest(out, {
    set: 'phone-terminal',
    recorder: 'benchmarks/rust-core/recorders/record-phone-terminal.mjs',
    command: `node benchmarks/rust-core/recorders/record-phone-terminal.mjs --tree <git archive of ${REF} (src, apps) with node_modules>`,
    identity: exactProductIdentity(tree, REF),
    extra: { steps: trace.steps.length },
  });
  commitStage(out, finalOut);
  console.log(`phone-terminal: ${trace.steps.length} steps`);
  process.exit(0);
}

rmSync(ROOT, { recursive: true, force: true });
const script = terminalScript(ROOT);
for (const dir of [script.cwd, script.watched, join(ROOT, 'userdata')]) mkdirSync(dir, { recursive: true });

const { createDesktopOperations } = await importFrom(tree, 'apps/desktop/src/main/desktop-operations.ts');
const { createRemoteMethods, executeRemoteFrame } = await importFrom(tree, 'apps/desktop/src/main/remote-methods.ts');
const { createRelayPushLanes } = await importFrom(tree, 'apps/desktop/src/main/remote-relay-push-lanes.ts');
const { remoteTerminalRun, TERMINAL_RUN_REQUESTED_DESKTOP_EVENT } = await importFrom(tree, 'apps/desktop/src/shared/terminal-command.ts');

// The phone's connection as the relay holds it: its lanes decide which pushes it reads.
const state = { lanes: new Set(), channel: {} };
const clients = new Map([[CONNECTION, state]]);
const events = { activity: [], sizeOwner: [], folder: [], run: [], output: '' };
const waiting = new Set();
const changed = () => {
  for (const check of [...waiting]) check();
};
const desktopListeners = new Set();
// What the phone's page hears of each push: the shim's dispatch (renderer/remote-shim-dispatch.ts, b6f10295a) read it through these.
const { readTerminalActivityEvent } = await importFrom(tree, 'apps/desktop/src/shared/terminal-activity.ts');
const { readRemoteTerminalRun } = await importFrom(tree, 'apps/desktop/src/shared/terminal-command.ts');
const pushes = {
  termActivity: (payload) => {
    const event = readTerminalActivityEvent(payload);
    if (event) events.activity.push(event);
  },
  termSizeOwner: (payload) =>
    events.sizeOwner.push({ id: String(payload.id || ''), cols: Number(payload.cols) || 0, rows: Number(payload.rows) || 0, own: payload.own === true }),
  folderChanged: (payload) => {
    if (String(payload || '')) events.folder.push(String(payload));
  },
  terminalRunRequested: (payload) => {
    const request = readRemoteTerminalRun(payload);
    if (request) events.run.push(request);
  },
};
const lanes = createRelayPushLanes({
  clients,
  broadcastEncrypted(frame, _droppable, include) {
    for (const client of clients.values()) {
      if (include && !include(client)) continue;
      pushes[frame.event](frame.payload);
    }
    changed();
  },
  subscribeDesktopEvents: (listener) => {
    desktopListeners.add(listener);
    return () => desktopListeners.delete(listener);
  },
});
const emit = (event) => {
  for (const listener of [...desktopListeners]) listener(event);
};
// The relay names this leg by the same id the size-owner events carry.
const operations = createDesktopOperations({
  userDataPath: join(ROOT, 'userdata'),
  packaged: false,
  resourcesPath: '',
  appPath: '',
  loadConfig: async () => ({}),
  emit,
});
// The relay's data push goes through its own 16 ms buffer; the text the page gets is the output as it was written.
operations.subscribeTerminalData((event) => {
  if (!state.lanes.has('terminal')) return;
  events.output += event.data;
  changed();
});
const methodsOf = (connection) =>
  createRemoteMethods(
    { host: { invokeDesktopOperation: (name, params) => operations.invoke(name, params) }, userDataPath: join(ROOT, 'userdata'), terminals: operations.terminals },
    { connectionId: () => connection }
  );
const methods = methodsOf(CONNECTION);
// A second paired connection, for the size-claim cases: it reads no lane, and closing it only removes it from the relay's client table.
const OTHER = 'conn-2';
const otherMethods = methodsOf(OTHER);
let frameId = 0;
const driver = {
  async call(name, params) {
    const response = await executeRemoteFrame(methods, JSON.stringify({ id: ++frameId, method: name, params }));
    if (!response.ok) throw new Error(response.error);
    return response.value;
  },
  fire(name, params, from) {
    void executeRemoteFrame(from === 'other' ? otherMethods : methods, JSON.stringify({ method: name, params }));
  },
  // The leases are Node timers; the virtual clock holds them from here and `advance` moves it.
  clock() {
    mock.timers.enable({ apis: ['setTimeout'] });
    clients.set(OTHER, { lanes: new Set(), channel: {} });
  },
  advance(ms) {
    mock.timers.tick(ms);
  },
  close(who) {
    if (who === 'other') clients.delete(OTHER);
  },
  lane(lane, on) {
    state.lanes[on ? 'add' : 'delete'](lane);
  },
  touch: (file) => writeFileSync(file, `${Date.now()}`),
  run(request, redeliver) {
    // The core's redelivery after a reconnect is not something Node had.
    if (redeliver) return;
    emit({ name: TERMINAL_RUN_REQUESTED_DESKTOP_EVENT, value: remoteTerminalRun(request) });
  },
  waitFor: (test) =>
    new Promise((resolve) => {
      const check = () => {
        if (!test(events)) return;
        waiting.delete(check);
        resolve();
      };
      waiting.add(check);
      check();
    }),
  events: () => events,
};
// A script that never gets its event ends with the unsettled wait; this says where it stood.
process.on('exit', () => process.stderr.write(`\nstate at exit: ${JSON.stringify({ ...events, output: events.output.slice(-200) })}\n`));
// Node's folder watches are not persistent (the desktop's own loop is alive), so this process keeps its loop alive while it waits.
const keepAlive = setInterval(() => {}, 1 << 30);
// `play` returns the driver's own event lists; the first trace is copied before the second script reuses them.
const trace = JSON.parse(JSON.stringify(await play(script, driver)));
// The size-claim cases run after, on their own tabs; only the claims' events are theirs to compare (the tabs' prompts race each other).
for (const list of Object.values(events)) if (Array.isArray(list)) list.length = 0;
const claimScript = sizeClaimScript(ROOT);
const claimTrace = await play(claimScript, driver);
mock.timers.reset();
trace.claims = { steps: claimTrace.steps, sizeOwner: claimTrace.sizeOwner };
clearInterval(keepAlive);
await operations.dispose();
lanes.dispose();
process.stdout.write(`\n@@TRACE@@${JSON.stringify(trace)}\n`);
process.exit(0);
