#!/usr/bin/env node
// What a phone's `termResize(id, cols, rows, phoneOwner)` does at the Node baseline (b6f10295a) for each kind of size value: the frame as the
// phone's shim sent it (JSON, so NaN, Infinity and undefined arrive as null), the real remote method (`createRemoteMethods`, which coerces
// with `Number`) and the real `TerminalManager.resize` (release for a non-positive claim, floor and clamp to 2..500 x 2..200 otherwise).
// A claim is recorded as the size-owner change it announces (after a claim of 50 x 20 by the same phone, so a release shows); a resize
// without a claim as the size the PTY was given.
//
//   node --import apps/desktop/scripts/test-env.mjs --import apps/desktop/scripts/test-tsx.mjs \
//        benchmarks/rust-core/recorders/record-terminal-resize.mjs --tree <git archive of b6f10295a with node_modules>
import { join } from 'node:path';
import { commitStage, exactProductIdentity, importFrom, parseArgs, REPO_ROOT, resolveTree, stageSet, writeJson, writeSetManifest } from './lib/common.mjs';

const REF = 'b6f10295a2f698afc85332467192de28500bd146';
const FIXTURES = join(REPO_ROOT, 'apps', 'mobile', 'fixtures', 'terminal-resize');
const tree = resolveTree(parseArgs());

const { createRemoteMethods, executeRemoteFrame } = await importFrom(tree, 'apps/desktop/src/main/remote-methods.ts');
const { TerminalManager } = await importFrom(tree, 'apps/desktop/src/main/terminal-manager.ts');

// The values a page can pass; `{ absent: true }` is `undefined`, which JSON cannot hold.
const VALUES = [
  ['negative', -1], ['zero', 0], ['negative zero', -0], ['fraction below one', 0.5], ['one', 1], ['fraction', 2.7], ['ordinary', 100],
  ['upper bound of columns', 500], ['above the column bound', 501], ['upper bound of rows', 200], ['above the row bound', 201],
  ['huge', 1e9], ['above u16', 70_000], ['NaN', NaN], ['Infinity', Infinity], ['-Infinity', -Infinity], ['numeric string', '100'],
  ['fraction string', '2.5'], ['text', 'abc'], ['empty string', ''], ['null', null], ['undefined', { absent: true }], ['true', true], ['false', false],
].map(([name, value]) => ({ name, value }));
const valueOf = (input) => (input.value?.absent ? undefined : input.value);

const ID = 'term_resize';
async function once(cols, rows, claim) {
  const manager = new TerminalManager();
  const sizes = [];
  // A running tab as the manager holds it, with a PTY that only says what size it was given.
  manager.terminals.set(ID, { pty: { resize: (c, r) => sizes.push({ cols: c, rows: r }) }, disposed: false });
  const owners = [];
  manager.subscribeSizeOwner((change) => owners.push(change));
  const methods = createRemoteMethods(
    { host: { invokeDesktopOperation: async () => null }, userDataPath: '', terminals: { resize: (...args) => manager.resize(...args) } },
    { connectionId: () => 'phone' }
  );
  if (claim) {
    await executeRemoteFrame(methods, JSON.stringify({ method: 'termResize', params: [ID, 50, 20, true] }));
    owners.length = 0;
    sizes.length = 0;
  }
  await executeRemoteFrame(methods, JSON.stringify({ method: 'termResize', params: [ID, cols, rows, claim] }));
  // The claims' lease timers are unref'd; the recording exits without waiting for them.
  return claim ? { owners } : { sizes };
}

const cases = [];
for (const claim of [true, false]) {
  for (const input of VALUES) {
    cases.push({ claim, axis: 'cols', input: input.name, ...(await once(valueOf(input), 24, claim)) });
    cases.push({ claim, axis: 'rows', input: input.name, ...(await once(100, valueOf(input), claim)) });
  }
}

const out = stageSet(FIXTURES);
writeJson(join(out, 'golden.json'), {
  note: "Node's termResize per kind of size value, as a phone sends it (a JSON frame) through the real remote method and TerminalManager.resize: `axis` is the value under test (the other is 24 rows or 100 columns); a claim (after the phone's claim of 50 x 20) records the size-owner changes announced, a plain resize the size the PTY was given.",
  values: VALUES,
  cases,
});
writeSetManifest(out, {
  set: 'terminal-resize',
  recorder: 'benchmarks/rust-core/recorders/record-terminal-resize.mjs',
  command: `node --import apps/desktop/scripts/test-env.mjs --import apps/desktop/scripts/test-tsx.mjs benchmarks/rust-core/recorders/record-terminal-resize.mjs --tree <git archive of ${REF} (src, apps) with node_modules>`,
  identity: exactProductIdentity(tree, REF),
  extra: { cases: cases.length },
});
commitStage(out, FIXTURES);
console.log(`terminal-resize: ${cases.length} cases`);
process.exit(0);
