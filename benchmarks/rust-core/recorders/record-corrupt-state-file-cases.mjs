#!/usr/bin/env node
// Recording of what Node does with a state file it finds corrupt (b6f10295a): the real code of every file the core keeps in
// state/core.sqlite (+ the one file that stays a file), driven over a damaged copy of it.
//   projects.json          shared/projects.mjs listProjects / addProject      (registry: Node's `projects` rows)
//   desktop-projects.json  apps/desktop project-preferences-file.ts           (aliases, hidden: Node's `projects` alias / hidden)
//   agent-rooms.json       apps/desktop agent-rooms.ts createAgentRoomFileStore (Node's `rooms` rows)
//   memory-cycle-state.json  memory cycle-scheduler health ledger (writer) + statusline-segments memoryCycleStatus (reader)
// Per file, per damage (garbage, NUL-filled, truncated), without and (where a writer keeps one) with a good `.bak`: what is on disk
// after the first read (the file, its `.bak`, every `<file>.corrupt-<ms>` and its bytes), what that read returned, what the next
// write returned and what the read after it returned. `shared` is what any store of that file must show, whatever it is made of:
// the compared part of the replay (`replay.rs`-side tests of mixdog-store `state.rs`).
//
//   node --import ./apps/desktop/scripts/test-env.mjs --import ./apps/desktop/scripts/test-tsx.mjs \
//        benchmarks/rust-core/recorders/record-corrupt-state-file-cases.mjs --tree <export of b6f10295a with node_modules>
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openSet } from './lib/case-set.mjs';
import { parseArgs, resolveTree } from './lib/common.mjs';

const set = openSet('corrupt-state-file-cases', import.meta.url);
const tree = resolveTree(parseArgs());
const { makeTempDirSync } = await set.load('scripts/lib/scoped-temp.mjs');
const { readProjectPreferences, writeProjectPreferences } = await set.load('apps/desktop/src/main/project-preferences-file.ts');
const { createAgentRoomFileStore } = await set.load('apps/desktop/src/main/agent-rooms.ts');
const { createCycleHealthLedger } = await set.load('src/runtime/memory/lib/cycle-scheduler/health-ledger.mjs');
const href = (rel) => pathToFileURL(join(tree, rel)).href;
let sequence = 0;
const roots = [];

/** The damages: bytes written over the file (as a crash or an editor leaves them), or the file cut to a part of itself. */
const DAMAGES = [
  { kind: 'garbage', bytes: '{broken' },
  { kind: 'nul-filled', bytes: '\u0000'.repeat(64) },
  { kind: 'truncated', keep: 'half' },
];

function damage(file, d) {
  const good = fs.readFileSync(file);
  if (d.kind === 'truncated') fs.writeFileSync(file, good.subarray(0, Math.floor(good.length / 2)));
  else fs.writeFileSync(file, d.bytes, 'latin1');
  return fs.readFileSync(file);
}

/** The disk around `file`: whether it and its `.bak` are there, and every set-aside copy by its suffix and bytes. */
function disk(root, name) {
  const names = fs.readdirSync(root);
  return {
    present: names.includes(name),
    bak: names.includes(`${name}.bak`),
    asides: names.filter((n) => n.startsWith(`${name}.corrupt-`)).sort().map((n) => ({ suffix: n.slice(name.length), bytes: fs.readFileSync(join(root, n)).toString('latin1') })),
  };
}

const asidesOf = (state) => state.asides.map((a) => a.suffix);
const sameBytes = (state, bytes) => state.asides.length > 0 && state.asides.every((a) => a.bytes === bytes.toString('latin1'));

/** One run: a good file (written twice when `backup`, so the writer's `.bak` exists), the damage, then read, write, read. */
async function runOne({ name, setup, read, write, readBack, shared }, d, backup) {
  const root = await fs.promises.realpath(makeTempDirSync('corrupt-state'));
  roots.push(root);
  try {
    const ctx = await setup(root, backup);
    const file = join(root, name);
    const damaged = damage(file, d);
    const first = await read(ctx);
    const afterRead = disk(root, name);
    const wrote = await write(ctx);
    const second = await readBack(ctx);
    const afterWrite = disk(root, name);
    return { file: name, damage: d, backup, damagedBytes: damaged.toString('latin1'), read: first, afterRead, write: wrote, readAfterWrite: second, afterWrite, shared: shared({ first, second, wrote, afterRead, afterWrite, damaged }) };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const shape = ({ empty, written, wrote, afterRead, afterWrite, damaged }) => ({
  asideSuffixes: asidesOf(afterRead),
  asideHoldsDamagedBytes: sameBytes(afterRead, damaged),
  readIsEmpty: empty,
  writeSucceeded: wrote.ok,
  readAfterWriteHasWrite: written,
  asideSuffixesAfterWrite: asidesOf(afterWrite),
});

const FILES = [
  {
    name: 'projects.json',
    backup: true,
    async setup(root, backup) {
      process.env.MIXDOG_DISABLE_PROJECT_MARKERS = '1';
      const saved = process.env.MIXDOG_PROJECTS_FILE;
      process.env.MIXDOG_PROJECTS_FILE = join(root, 'projects.json');
      let store;
      try { store = await import(`${href('src/runtime/shared/projects.mjs')}?corrupt=${sequence++}`); } finally { if (saved === undefined) delete process.env.MIXDOG_PROJECTS_FILE; else process.env.MIXDOG_PROJECTS_FILE = saved; }
      const dirs = ['first', 'second', 'third'].map((n) => { const p = join(root, n); fs.mkdirSync(p); return p; });
      store.addProject(dirs[0]);
      if (backup) store.addProject(dirs[1]);
      return { store, dirs };
    },
    read: ({ store }) => store.listProjects().map((p) => p.path),
    write: ({ store, dirs }) => { const entry = store.addProject(dirs[2]); return { ok: entry !== null, entry: entry && { name: entry.name, path: entry.path, addedAt: entry.addedAt } }; },
    readBack: ({ store }) => store.listProjects().map((p) => p.path),
    shared: (r) => shape({ empty: r.first.length === 0, written: r.second.some((p) => p.endsWith('third')), ...r }),
  },
  {
    name: 'desktop-projects.json',
    backup: true,
    async setup(root, backup) {
      await writeProjectPreferences(root, { version: 2, aliases: { [join(root, 'first')]: 'First' }, hidden: [] });
      if (backup) await writeProjectPreferences(root, { version: 2, aliases: { [join(root, 'first')]: 'First' }, hidden: [join(root, 'second')] });
      return { root };
    },
    read: ({ root }) => readProjectPreferences(root),
    write: async ({ root }) => { await writeProjectPreferences(root, { version: 2, aliases: { [join(root, 'third')]: 'Third' }, hidden: [] }); return { ok: true }; },
    readBack: ({ root }) => readProjectPreferences(root),
    shared: (r) => shape({ empty: Object.keys(r.first.aliases).length === 0 && r.first.hidden.length === 0, written: Object.values(r.second.aliases).includes('Third'), ...r }),
  },
  {
    name: 'agent-rooms.json',
    backup: true,
    async setup(root, backup) {
      const store = createAgentRoomFileStore(join(root, 'agent-rooms.json'));
      const room = (id) => ({ id, name: `Room ${id}`, members: ['a', 'b'], maxRounds: 3, maxMessages: 8, shareTools: false, createdAt: 1, cursors: {} });
      await store.save({ rooms: { first: room('first') } });
      if (backup) await store.save({ rooms: { first: room('first'), second: room('second') } });
      return { store, room };
    },
    read: ({ store }) => store.load(),
    write: async ({ store, room }) => { await store.save({ rooms: { third: room('third') } }); return { ok: true }; },
    readBack: ({ store }) => store.load(),
    shared: (r) => shape({ empty: Object.keys(r.first.rooms).length === 0, written: 'third' in r.second.rooms, ...r }),
  },
  {
    name: 'memory-cycle-state.json',
    backup: false,
    async setup(root) {
      process.env.MIXDOG_DATA_DIR = root;
      const file = join(root, 'memory-cycle-state.json');
      const ledger = createCycleHealthLedger({ cycleStateFile: file, log: () => {} });
      ledger.markRunning('cycle1');
      return { ledger, root };
    },
    // The statusline's reader: a render-path call that refreshes in the background; the refresh's read of the file is awaited, then the cache is read.
    async read({ root }) { return statusline(root); },
    write: ({ ledger }) => { ledger.markRunning('cycle1'); return { ok: true }; },
    readBack: ({ root }) => statusline(root),
    shared: (r) => shape({ empty: r.first === null, written: r.second !== null, ...r }),
  },
];

/** `memoryCycleStatus()` of a fresh statusline module (its 1 s cache starts empty), after the refresh it starts has read the file. */
async function statusline(root) {
  const file = join(root, 'memory-cycle-state.json');
  const { memoryCycleStatus } = await import(`${href('src/runtime/shared/statusline/statusline-segments.mjs')}?cycle=${sequence++}`);
  const original = fs.promises.readFile;
  let read = null;
  fs.promises.readFile = (path, ...args) => { const p = original(path, ...args); if (path === file) read = p; return p; };
  syncBuiltinESMExports();
  try {
    memoryCycleStatus();
    await read?.catch(() => null);
    for (let turn = 0; turn < 3; turn += 1) await new Promise((r) => setImmediate(r));
    return memoryCycleStatus();
  } finally {
    fs.promises.readFile = original;
    syncBuiltinESMExports();
  }
}

await set.run('a corrupt ${file} is kept aside (or replaced, for the cycle state) and the next read and write work', async () => {
  const runs = [];
  for (const file of FILES) {
    for (const d of DAMAGES) {
      for (const backup of file.backup ? [false, true] : [false]) runs.push(await runOne(file, d, backup));
    }
  }
  return { runs };
});

await set.finish({
  entry: { runs: 'the real registry (shared/projects.mjs), desktop preferences (project-preferences-file.ts), room store (agent-rooms.ts createAgentRoomFileStore), cycle health ledger and statusline reader, over a damaged file in a temp directory', notRun: 'no daemon, no Electron' },
  replay: { entry: 'mixdog-store state.rs CoreState::open_or_set_aside over a damaged state/core.sqlite (projects, desktop preferences and rooms are its tables), mixdog-services Ledger over a damaged memory-cycle-state.json: `shared` of every run without a `.bak`', normalised: { dataDir: '<root>, wherever it occurs' } },
  exclusions: {
    '$.cases[0].observed.runs[*] where backup is true': 'state/core.sqlite has no `.bak`: Node restores the last good copy of a file it sets aside, the core starts a new database and gives back from the session catalog what that records (projects, rooms); the restored content is Node-side data with no core counterpart',
    '$.cases[0].observed.runs[*].read / .write / .readAfterWrite of the four files': 'Node-specific value shapes (a project list, a preferences object, a room document, a statusline segment); the replay compares `shared`, which restates them as emptiness and presence',
    '$.cases[0].observed.runs[*] of memory-cycle-state.json, `read` / `readAfterWrite` (the statusline)': 'the statusline reader is Node code; the core has no reader of memory-cycle-state.json, only the ledger that writes it',
  },
  replaceInText: roots.map((r) => [r, '<root>']),
  normaliseReason: 'per-run temp root written <root>',
});
process.exit(0);
