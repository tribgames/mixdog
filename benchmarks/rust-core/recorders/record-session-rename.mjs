#!/usr/bin/env node
// Golden twin of a user's session rename: what Node's runtime `updateSessionManualTitle`
// (src/runtime/agent/orchestrator/session/manager/session-crud.mjs) returns and leaves on the stored session, and what the
// desktop host's `renameSession` (apps/desktop/src/main/session-host-lifecycle.ts) throws or accepts over it, for planted
// sessions in an isolated data dir.
//
//   node --experimental-transform-types --import benchmarks/rust-core/recorders/lib/ts-register.mjs benchmarks/rust-core/recorders/record-session-rename.mjs --tree <dir>
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FIXTURES_ROOT, importFrom, parseArgs, resolveTree } from './lib/common.mjs';

const tree = resolveTree(parseArgs());
const root = mkdtempSync(join(tmpdir(), 'mixdog-rename-twin-'));
process.env.MIXDOG_DATA_DIR = root;
mkdirSync(join(root, 'sessions'));
const { drainSessionStore, saveSessionAsync } = await importFrom(tree, 'src/runtime/agent/orchestrator/session/store.mjs');
const { settleSessionSummaryIndex } = await importFrom(tree, 'src/runtime/agent/orchestrator/session/store/listing.mjs');
const { getSession, updateSessionManualTitle } = await importFrom(tree, 'src/runtime/agent/orchestrator/session/manager/session-crud.mjs');
const { SessionHostLifecycle } = await importFrom(tree, 'apps/desktop/src/main/session-host-lifecycle.ts');

const STATES = {
  fresh: {},
  user: { title: 'Mine', titleLocked: true, titleSource: 'user' },
  ai: { title: 'AI title', titleLocked: true, titleSource: 'ai' },
  legacyLocked: { title: 'Old', titleLocked: true },
  generated: { title: 'Generated' },
  closed: { title: 'Gone', closed: true },
};
const TITLES = [
  'Valid name',
  '  Valid   spaced  name ',
  '',
  '   ',
  '\n\t',
  'Mine',
  'AI title',
  'Old',
  'x'.repeat(150),
  '한글 이름',
];

let n = 0;
async function plant(state) {
  n += 1;
  const id = `sess_rename_${String(n).padStart(4, '0')}`;
  const session = { id, provider: 'openai', model: 'm', cwd: root, messages: [], generation: 0, closed: false, ...STATES[state] };
  await saveSessionAsync(session, { expectedGeneration: session.generation });
  return id;
}
const kept = (id) => {
  const session = getSession(id);
  return session
    ? { title: session.title ?? null, titleLocked: session.titleLocked ?? null, titleSource: session.titleSource ?? null, stamped: Boolean(session.titleUpdatedAt) }
    : null;
};

const cases = [];
for (const state of Object.keys(STATES)) {
  for (const title of TITLES) {
    const direct = await plant(state);
    const returned = await updateSessionManualTitle(direct, title);
    // The desktop host over the same runtime call, on a session in the same state.
    const hosted = await plant(state);
    const lifecycle = Object.create(SessionHostLifecycle.prototype);
    lifecycle.owner = {
      invokeControl: async (_capability, args) => updateSessionManualTitle(...args),
      sessionMetadata: { setName: async () => {} },
      publishCatalogs: async () => {},
    };
    let desktop;
    try {
      await lifecycle.renameSession(hosted, title);
      desktop = { ok: true };
    } catch (error) {
      desktop = { error: error.message, kind: error.constructor.name };
    }
    cases.push({ state, initial: STATES[state], title, runtime: { returned, kept: kept(direct) }, desktop: { ...desktop, kept: kept(hosted) } });
  }
}
// A session that does not exist.
const missing = { returned: await updateSessionManualTitle('sess_rename_missing', 'Name') };
const lifecycle = Object.create(SessionHostLifecycle.prototype);
lifecycle.owner = { invokeControl: async (_c, args) => updateSessionManualTitle(...args), sessionMetadata: { setName: async () => {} }, publishCatalogs: async () => {} };
try {
  await lifecycle.renameSession('sess_rename_missing', 'Name');
  missing.desktop = { ok: true };
} catch (error) {
  missing.desktop = { error: error.message, kind: error.constructor.name };
}

drainSessionStore();
await settleSessionSummaryIndex();
rmSync(root, { recursive: true, force: true });
writeFileSync(
  `${FIXTURES_ROOT}/desktop/settings/session-rename-twin.json`,
  `${JSON.stringify({ domain: 'session-rename-twin', recorder: 'benchmarks/rust-core/recorders/record-session-rename.mjs', cases, missing }, null, 1)}\n`
);
console.log(`recorded ${cases.length} rename cases`);
