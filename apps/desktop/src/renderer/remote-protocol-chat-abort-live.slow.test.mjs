// The Stops against a RUNNING mixdogd, each time: the core built at MIXDOGD_EXE is driven through the cases of
// remote-protocol-chat-abort-cases.mjs (remote-protocol-chat-abort-live.mjs) and what the phone reads of it is compared, whole, with what Node's
// daemon + SessionHost gave the phone for the same cases (remote-protocol-chat-abort.recorded.json and .rerecorded.json, two runs of the
// exact b6f10295a export): the replies to the phone's calls, the stored transcript, the list row, the prompt handed back, and the whole
// ordered stream of what the phone was told (replies, session states, list-row changes). The rule is remote-protocol-chat-abort-compare.mjs.
// Without MIXDOGD_EXE / REAL_TURN_HARNESS naming real files this file fails: there is no replay fallback.
// Run directly with `--only <case name>` (node --test-force-exit … remote-protocol-chat-abort-live.slow.test.mjs --only running-pasted-text,
// the flag scripts/test.mjs gives every file), it drives and
// compares that one case; the default (and the test lane) runs every case.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { desktopSessionState, sessionReducer } from '../../../../packages/protocol-client/src/session-state.ts';
import { summariesOfThreadRows } from '../main/protocol/thread-rows.ts';
import { canonical, runOwnPaths, streamOrder } from './remote-protocol-chat-abort-compare.mjs';
import { runAbortLive } from './remote-protocol-chat-abort-live.mjs';

const recording = (name) => JSON.parse(readFileSync(new URL(`./${name}`, import.meta.url), 'utf8'));
// Two recordings of Node's own code on the same cases: what differs between them is a run's own (remote-protocol-chat-abort-compare.mjs).
const node = recording('remote-protocol-chat-abort.recorded.json');
const again = recording('remote-protocol-chat-abort.rerecorded.json');
const onlyAt = process.argv.indexOf('--only');
const only = onlyAt === -1 ? undefined : process.argv[onlyAt + 1];
const live = await runAbortLive({ only });
const nodeCases = node.cases.filter((c) => only === undefined || c.name === only);
/** The environment's own folder (each side runs in its own) is the same folder for both. */
const folders = (value) => JSON.parse(JSON.stringify(value).replace(/[^"]*?env-ph2-chat-abort-(node|live)(\\\\|\/)/g, '<env>/'));
/** The transcript rows the production fold gives for a thread snapshot's items (session-state.ts `sessionReducer.initial` + `desktopSessionState`). */
const foldRows = (items) => JSON.parse(JSON.stringify(desktopSessionState(sessionReducer.initial({ thread: { id: 'abort-live' }, items, state: {} }), []).items));
/** What the phone got of a case, on either side, in one shape. */
const told = (side) => folders({
  reply: side.reply ?? null,
  ...(side.second !== undefined ? { second: side.second } : {}),
  ...(side.answers ? { answers: side.answers } : {}),
  items: side.items,
  row: side.row,
  promptRestore: side.promptRestore ?? null,
  stream: side.stream,
});

test('the run is of the built core and holds Node\'s cases', () => {
  assert.match(live.manifest.binarySha256, /^[0-9a-f]{64}$/);
  assert.equal(node.manifest.exact, true);
  assert.deepEqual(live.cases.map((c) => c.name), nodeCases.map((c) => c.name));
});

for (const nodeCase of nodeCases) {
  test(`${nodeCase.name}: what the phone was told is Node's, whole and in order`, () => {
    const core = live.cases.find((c) => c.name === nodeCase.name).core;
    const recorded = [nodeCase.node, again.cases.find((c) => c.name === nodeCase.name).node].map(told);
    const runOwn = runOwnPaths(recorded);
    const mine = told({ ...core, items: foldRows(core.items), row: core.row ? JSON.parse(JSON.stringify(summariesOfThreadRows([core.row])[0])) : null });
    const want = recorded.map((r) => canonical(r, runOwn));
    const got = canonical(mine, runOwn);
    const { stream: gotStream, ...gotRest } = got;
    const { stream: _w, ...wantRest } = want[0];
    assert.deepEqual(gotRest, wantRest, 'the replies, the stored transcript, the list row and the prompt handed back');
    // The stream: one of the orders Node showed, and in it everything Node told.
    const sameOrder = want.find((w) => streamOrder(w.stream) === streamOrder(gotStream));
    assert.deepEqual(gotStream, (sameOrder ?? want[0]).stream, `the stream (Node's orders: ${[...new Set(want.map((w) => streamOrder(w.stream)))].join(' | ')})`);
  });
}
