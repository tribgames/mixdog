#!/usr/bin/env node
// How the session list shows group rooms (`apps/desktop/src/main/agent-room-views.ts`):
// `roomSummary` (the `agentRoom` of a room's log row) and `catalogWithRooms` (each room's log
// row stamped with the room's name and last message time, member sessions and the log rows of
// rooms that are gone left out). The real TypeScript is bundled with esbuild, unchanged, and run
// over crafted catalog rows and room records.
//
//   node benchmarks/rust-core/recorders/record-room-catalog.mjs --tree <tree w/ node_modules>
// Output: native/core/fixtures/room-catalog/golden.json
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FIXTURES_ROOT, commitStage, importFrom, parseArgs, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const sandbox = mkdtempSync(join(tmpdir(), 'room-catalog-'));
process.env.MIXDOG_DATA_DIR = sandbox;
process.env.MIXDOG_HOME = sandbox;
process.on('exit', () => rmSync(sandbox, { recursive: true, force: true }));
const tree = resolveTree(parseArgs());

const esbuild = await importFrom(tree, 'node_modules/esbuild/lib/main.js');
const main = join(tree, 'apps/desktop/src/main');
const outfile = join(sandbox, 'views.mjs');
await esbuild.build({
  stdin: {
    contents: readFileSync(join(main, 'agent-room-views.ts'), 'utf8'),
    sourcefile: join(main, 'agent-room-views.ts'),
    resolveDir: main,
    loader: 'ts',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile,
  logLevel: 'error',
});
const views = await import(pathToFileURL(outfile).href);

/** A catalog row as `thread/list` lists it (the fields a `ThreadSummary` requires, plus extras). */
const row = (id, extra = {}) => ({
  id,
  preview: `preview of ${id}`,
  title: `title of ${id}`,
  updatedAt: 1000,
  messageCount: 3,
  cwd: 'C:\\Tasks',
  classification: 'task',
  projectPath: null,
  ...extra,
});

/** A stored room record (`agent-rooms.json` / the `rooms` table document). */
const room = (id, extra = {}) => ({
  id,
  name: `Room ${id}`,
  members: ['lead', 'gh.bot'],
  maxRounds: 3,
  maxMessages: 6,
  shareTools: false,
  createdAt: 500,
  cursors: {},
  seen: {},
  running: null,
  submissions: [],
  ...extra,
});

const names = { lead: 'Mixy', 'gh.bot': 'Git Hub', alpha: 'Alpha' };

function run(name, { rows, rooms, running = [] }) {
  const byId = Object.fromEntries(rooms.map((r) => [r.id, r]));
  const nameMap = new Map(Object.entries(names));
  const busy = new Set(running);
  const out = views.catalogWithRooms(rows, byId, (r) => views.roomSummary(r, nameMap, busy.has(r.id)));
  return { name, rows, rooms, running, out };
}

const cases = [
  run('a row of no room passes as it is', { rows: [row('sess_desktop_a', { activityAt: 1200 })], rooms: [] }),
  run('a room log row takes the room name, its last message time and the summary', {
    rows: [row('sess_room_room01', { activityAt: 1500, updatedAt: 1400 })],
    rooms: [room('room01', { lastAt: 2000, lastSpeaker: 'gh.bot', lastPreview: 'Done, see the PR.' })],
  }),
  run('a room with no message yet keeps the later of the row times', {
    rows: [row('sess_room_room02', { activityAt: 1700, updatedAt: 1600 })],
    rooms: [room('room02')],
  }),
  run('a row with no activity time falls back to its update time', {
    rows: [row('sess_room_room03', { updatedAt: 1800 })],
    rooms: [room('room03')],
  }),
  run('a running room says so', {
    rows: [row('sess_room_room04', { activityAt: 900 })],
    rooms: [room('room04', { lastAt: 950, lastSpeaker: 'user', lastPreview: 'go on' })],
    running: ['room04'],
  }),
  run('a member name the catalog does not know is the member id', {
    rows: [row('sess_room_room05')],
    rooms: [room('room05', { members: ['alpha', 'stranger'], lastAt: 1234 })],
  }),
  run('empty last speaker and preview are left out', {
    rows: [row('sess_room_room06')],
    rooms: [room('room06', { lastSpeaker: '', lastPreview: '', lastAt: 1300 })],
  }),
  run('member sessions are left out', {
    rows: [row('sess_rmem_room01_gh_bot'), row('sess_rmem_room01_lead'), row('sess_room_room01'), row('sess_desktop_b')],
    rooms: [room('room01', { lastAt: 1100 })],
  }),
  run('the log row of a room that is gone is left out', {
    rows: [row('sess_room_gone01'), row('sess_desktop_c')],
    rooms: [],
  }),
  run('several rooms in one page keep the page order', {
    rows: [row('sess_room_room07', { activityAt: 3000 }), row('sess_desktop_d', { activityAt: 2500 }), row('sess_room_room08', { activityAt: 2000 })],
    rooms: [room('room08', { lastAt: 4000, members: ['lead'] }), room('room07', { lastAt: 100, shareTools: true, maxRounds: 1, maxMessages: 2 })],
    running: ['room08'],
  }),
];

const finalOut = join(FIXTURES_ROOT, 'room-catalog');
const out = stageSet(finalOut);
writeJson(join(out, 'golden.json'), {
  note: 'what the real 1.4.5 desktop agent-room-views.ts catalogWithRooms/roomSummary answer; every room of a case has its log row listed (the page-free synthetic row of an unlisted room is not recorded)',
  names,
  cases,
});
writeSetManifest(out, {
  set: 'room-catalog',
  recorder: 'benchmarks/rust-core/recorders/record-room-catalog.mjs',
  command: 'node benchmarks/rust-core/recorders/record-room-catalog.mjs --tree <tree>',
  extra: { cases: cases.length },
});
commitStage(out, finalOut);
console.log(`cases=${cases.length}`);
