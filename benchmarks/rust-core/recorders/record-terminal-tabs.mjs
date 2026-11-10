// Records what the Node terminal manager reports for the agent `terminal` bridge (`termSessionTabs` /
// `termSnapshot`, apps/desktop/src/main/terminal-manager.ts) into fixtures/terminal-tabs/session-tabs.json,
// which TabsTerminalPort's test replays. The PTY is a scripted stand-in injected where the manager loads
// node-pty; everything else is the real manager of the exact tree.
//   node --experimental-transform-types --import benchmarks/rust-core/recorders/lib/ts-register.mjs benchmarks/rust-core/recorders/record-terminal-tabs.mjs --tree <git archive of b6f10295a with node_modules> --commit b6f10295a2f698afc85332467192de28500bd146
import { join } from 'node:path';

import { FIXTURES_ROOT, commitStage, exactProductIdentity, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const args = parseArgs();
const tree = resolveTree(args);
const identity = exactProductIdentity(tree, args.get('commit') ?? (() => { throw new Error('--commit is required'); })());
const recorder = 'benchmarks/rust-core/recorders/record-terminal-tabs.mjs';
const finalDir = join(FIXTURES_ROOT, 'terminal-tabs');
const { TerminalManager } = await importFrom(tree, 'apps/desktop/src/main/terminal-manager.ts');
const CWD = '{cwd}';
const ptys = new Map();
function fakePty() {
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
}

const manager = new TerminalManager();
manager.ptyModule = Promise.resolve({
  spawn: () => {
    const pty = fakePty();
    ptys.set(manager.lastSpawn, pty);
    return pty;
  },
});
const ownBase = {};
const ensure = async (id) => {
  manager.lastSpawn = id;
  await manager.ensure(id, CWD, null);
  ownBase[id] = manager.snapshot(id)?.cursor;
};

// Spawned out of order: the listing must come back ordered by tab number.
for (const id of ['session-terminal:S:3', 'session-terminal:S', 'session-terminal:S:2', 'session-terminal:T', 'term_other', 'session-terminal:S:03', 'session-terminal:S:0']) {
  await ensure(id);
}

const listing = {};
for (const session of ['S', 'T', 'none', 'S:2']) listing[session] = manager.sessionTabs(session);

ptys.get('session-terminal:S').data('hello\r\nworld\r\n');
const first = manager.snapshot('session-terminal:S');
const base = first.cursor - first.text.length;
ptys.get('session-terminal:S').data('more\r\n');
const second = manager.snapshot('session-terminal:S');
const since = (cursor) => manager.snapshot('session-terminal:S', cursor);

// The recorded facts are relative to the cursor base (an epoch that differs per run).
const rel = (n) => n - base;
const shape = (snap) => (snap === null ? null : { text: snap.text, cursor: rel(snap.cursor), reset: snap.reset });
// A tab other than S has its own base; its cursor is recorded against that, never against S's.
const shapeOwn = (id, snap) => (snap === null ? null : { text: snap.text, cursor: snap.cursor - ownBase[id], reset: snap.reset });
const snapshots = {
  all: shape(second),
  sinceFirstCursor: shape(since(first.cursor)),
  sinceStart: shape(since(base)),
  sinceMiddle: shape(since(base + 7)),
  sinceEnd: shape(since(second.cursor)),
  belowWindow: shape(since(base - 1)),
  pastEnd: shape(since(second.cursor + 1)),
  unknown: shape(manager.snapshot('session-terminal:nope')),
  other: shapeOwn('session-terminal:T', manager.snapshot('session-terminal:T')),
};

// An exited tab stays listed, as not running, and its snapshot ends with the exit line.
ptys.get('session-terminal:S:3').exit({ exitCode: 7 });
const exited = manager.sessionTabs('S');
const exitedSnapshot = shapeOwn('session-terminal:S:3', manager.snapshot('session-terminal:S:3'));
manager.dispose('session-terminal:S:2');
const afterDispose = { tabs: manager.sessionTabs('S'), snapshot: manager.snapshot('session-terminal:S:2') };

manager.dispose('session-terminal:S');
manager.dispose('session-terminal:S:3');
manager.dispose('session-terminal:T');
manager.dispose('term_other');

const stage = stageSet(finalDir, []);
writeJson(join(stage, 'session-tabs.json'), { cwd: CWD, listing, snapshots, firstWrite: 'hello\r\nworld\r\n', secondWrite: 'more\r\n', exited, exitedSnapshot, afterDispose });
writeSetManifest(stage, {
  set: 'terminal-tabs',
  recorder,
  command: `node --experimental-transform-types --import benchmarks/rust-core/recorders/lib/ts-register.mjs ${recorder} --tree <tree> --commit ${identity.commit}`,
  identity,
});
commitStage(stage, finalDir);
process.exit(0);
