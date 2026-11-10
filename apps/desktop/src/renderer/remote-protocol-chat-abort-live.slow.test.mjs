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
import { differences, verifiedRecordings } from './remote-protocol-chat-abort-fixture.mjs';
import { runAbortLive } from './remote-protocol-chat-abort-live.mjs';

// N recordings of Node's own code on the same cases, at the phone (remote-protocol-chat-abort-fixture.mjs, the rule in -compare.mjs).
const { recordings } = verifiedRecordings();
const onlyAt = process.argv.indexOf('--only');
const only = onlyAt === -1 ? undefined : process.argv[onlyAt + 1];
const live = await runAbortLive({ only });
const names = recordings[0].cases.map((c) => c.name).filter((name) => only === undefined || name === only);
/** The transcript rows the production fold gives for a thread snapshot's items (session-state.ts `sessionReducer.initial` + `desktopSessionState`). */
const foldRows = (items) => JSON.parse(JSON.stringify(desktopSessionState(sessionReducer.initial({ thread: { id: 'abort-live' }, items, state: {} }), []).items));
const nodeSides = (name) => recordings.map((r) => r.cases.find((c) => c.name === name).node);
const nodeId = (name) => recordings[0].cases.find((c) => c.name === name).id;

test('the run is of the built core and holds Node\'s cases', () => {
  assert.match(live.manifest.binarySha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(live.cases.map((c) => c.name), names);
});

for (const name of names) {
  const ran = () => live.cases.find((c) => c.name === name);
  // D, declared: the core names a phone's new task with its own conversation id where Node derives one from the submission
  // (new-task-requests.ts:145,185); that is fixed on branch phone-new-task-dedupe. This test holds it, failing, until then; the
  // comparison below reads the core's id as Node's so that it judges everything else.
  test(`${name}: D — the new task's conversation id is Node's`, () => {
    assert.equal(ran().id, nodeId(name));
  });
  test(`${name}: what the phone was told is what Node's recordings show`, () => {
    const { core } = ran();
    const side = JSON.parse(JSON.stringify({ ...core, items: foldRows(core.items), row: core.row ? summariesOfThreadRows([core.row])[0] : null }).replaceAll(ran().id, nodeId(name)));
    assert.deepEqual(differences(side, nodeSides(name)), []);
  });
}
