// Records the failure paths and payloads of the desktop's `term*` operations that the phone's terminal and
// the agent `terminal` tool read (apps/desktop/src/main/desktop-operations.ts: termEnsure, termAttach,
// termSessionTabs, termSnapshot, termResize), into fixtures/terminal-ops/failure-paths.json, which
// native/mixdog-spawn/tests/terminal.rs replays on real tabs. The operations are the real dispatcher
// (`createDesktopOperations`) over the real TerminalManager; only the PTY is a scripted stand-in injected
// where the manager loads node-pty, so the recorded text is the script's own.
//   node --experimental-transform-types --import ./benchmarks/rust-core/recorders/lib/ts-register.mjs benchmarks/rust-core/recorders/record-terminal-ops.mjs --tree <git archive of b6f10295a with node_modules> --commit b6f10295a2f698afc85332467192de28500bd146
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FIXTURES_ROOT, commitStage, exactProductIdentity, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const args = parseArgs();
const tree = resolveTree(args);
const identity = exactProductIdentity(tree, args.get('commit') ?? (() => { throw new Error('--commit is required'); })());
const recorder = 'benchmarks/rust-core/recorders/record-terminal-ops.mjs';
const finalDir = join(FIXTURES_ROOT, 'terminal-ops');
const work = mkdtempSync(join(tmpdir(), 'mixdog-term-ops-'));
const userData = join(work, 'userData');
mkdirSync(userData, { recursive: true });
process.env.MIXDOG_DATA_DIR = join(work, 'data');
process.env.MIXDOG_HOME = join(work, 'home');

const { TerminalManager } = await importFrom(tree, 'apps/desktop/src/main/terminal-manager.ts');
const { createDesktopOperations } = await importFrom(tree, 'apps/desktop/src/main/desktop-operations.ts');

const ptys = [];
const fakePty = () => {
  const pty = {
    data: () => {},
    exit: () => {},
    onData(cb) {
      pty.data = cb;
    },
    onExit(cb) {
      pty.exit = cb;
    },
    write() {},
    resize() {},
    pause() {},
    resume() {},
    kill() {
      pty.exit({ exitCode: 0 });
    },
  };
  return pty;
};
TerminalManager.prototype.loadPtyBindings = () =>
  Promise.resolve({
    spawn: () => {
      const pty = fakePty();
      ptys.push(pty);
      return pty;
    },
  });

const ops = createDesktopOperations({ userDataPath: userData, packaged: false, resourcesPath: undefined, appPath: join(tree, 'apps', 'desktop'), emit: () => {} });
const byId = new Map();
const cases = [];
const GENERATED = /^term_\d+_\d+$/;
const call = async (op, input, shape = (v) => v) => {
  const spawned = ptys.length;
  let out;
  try {
    out = { result: shape(await ops.invoke(op, input)) };
  } catch (error) {
    out = { error: String(error?.message ?? error) };
  }
  if (op === 'termEnsure' && ptys.length > spawned && out.result?.id) byId.set(out.result.id, ptys.at(-1));
  return out;
};
const record = async (name, op, input, shape) => {
  cases.push({ name, op, args: input, ...(await call(op, input, shape)) });
};
// A generated id carries this process's pid; everything else is the manager's own answer.
const session = (value) => (value && typeof value === 'object' ? { ...value, id: GENERATED.test(value.id) ? '<generated>' : value.id } : value);

const S = 'session-terminal:S';
// -- termSessionTabs: what the operation makes of a missing, empty, odd or unknown session id.
for (const input of [[], [''], [null], [123], ['nope']]) await record(`tabs of ${JSON.stringify(input)} with no tab open`, 'termSessionTabs', input);

// -- termAttach never starts a terminal.
for (const input of [[], [''], [null], ['nope'], [S]]) await record(`attach ${JSON.stringify(input)} before anything runs`, 'termAttach', input);

// -- termEnsure: ids the manager does not accept become generated ones; an accepted id is reused.
await record('ensure a session tab', 'termEnsure', [S, null, null], session);
for (const input of [[null, null, null], ['bad id', null, null], ['term_', null, null], ['', null, null], ['session-terminal:', null, null]]) {
  await record(`ensure ${JSON.stringify(input[0])}`, 'termEnsure', input, session);
}
byId.get(S).data('hello\r\nworld\r\n');
await record('ensure the same id again replays what it printed', 'termEnsure', [S, null, null], session);
await record('attach the running tab', 'termAttach', [S]);
byId.get(S).data('more\r\n');

// -- termSnapshot: a cursor given absolutely, relative to the tab's base (an epoch that differs per run).
const first = (await ops.invoke('termSnapshot', [S, undefined])) ?? (() => { throw new Error('no snapshot'); })();
const base = first.cursor - first.text.length;
const total = first.text.length;
const absolute = (spec) => (spec && typeof spec === 'object' ? base + spec.rel : spec);
const shape = (snap) => (snap === null ? null : { text: snap.text, cursor: snap.cursor - base, reset: snap.reset });
for (const spec of [undefined, null, 0, { rel: 0 }, { rel: 7 }, { rel: total - 1 }, { rel: total }, { rel: total + 1 }, { rel: -1 }]) {
  const input = [S];
  if (spec !== undefined) input.push(spec);
  const asked = [S];
  if (spec !== undefined) asked.push(absolute(spec));
  cases.push({ name: `snapshot since ${JSON.stringify(spec)}`, op: 'termSnapshot', args: input, ...(await call('termSnapshot', asked, shape)) });
}
for (const input of [[], [''], [null], ['nope'], ['nope', 5], [S.toUpperCase()]]) await record(`snapshot ${JSON.stringify(input)} of a tab that is not there`, 'termSnapshot', input);

// -- a phone's size claim travels in the attach payload, and releasing it takes it away.
await record('a phone claims the size', 'termResize', [S, 100, 30, 'client-a']);
await record('attach while the phone owns the size', 'termAttach', [S]);
await record('ensure while the phone owns the size', 'termEnsure', [S, null, null], session);
await record('the phone releases it', 'termResize', [S, 0, 0, 'client-a']);
await record('attach after the release', 'termAttach', [S]);

// -- an exited tab: not attachable, still snapshot-able, and ensured again it starts from nothing.
byId.get(S).exit({ exitCode: 7 });
await record('attach an exited tab', 'termAttach', [S]);
cases.push({ name: 'snapshot an exited tab', op: 'termSnapshot', args: [S], ...(await call('termSnapshot', [S], shape)) });
await record('tabs of S after the exit', 'termSessionTabs', ['S'], (tabs) => tabs.map((t) => ({ tab: t.tab, id: t.id, running: t.running })));
await record('ensure the exited id again', 'termEnsure', [S, null, null], session);
await record('attach the respawned tab', 'termAttach', [S]);

// -- dispose: gone for attach and snapshot.
await record('dispose it', 'termDispose', [S]);
await record('attach a disposed tab', 'termAttach', [S]);
await record('snapshot a disposed tab', 'termSnapshot', [S]);
await record('tabs after the dispose', 'termSessionTabs', ['S']);
await record('write to a tab that is not there', 'termWrite', ['nope', 'x']);

const stage = stageSet(finalDir, []);
writeJson(join(stage, 'failure-paths.json'), { total, cases });
writeSetManifest(stage, {
  set: 'terminal-ops',
  recorder,
  command: `node --experimental-transform-types --import ./benchmarks/rust-core/recorders/lib/ts-register.mjs ${recorder} --tree <tree> --commit ${identity.commit}`,
  identity,
});
commitStage(stage, finalDir);
process.exit(0);
