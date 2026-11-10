// The N recordings of Node's Stop cases (remote-protocol-chat-abort.record.mjs, run N times), verified on load
// (remote-protocol-chat-fixtures.mjs). The comparison of a side (Node's or the core's) with them is remote-protocol-chat-abort-compare.mjs `judge`.
import { judge, nodeVariants, normalized, runOwnOf } from './remote-protocol-chat-abort-compare.mjs';
import { verifiedFixture } from './remote-protocol-chat-fixtures.mjs';

/** The manifest the recordings were installed with (count, order, hashes), checked against the folder and the recorder now. */
export const verifiedRecordings = () => verifiedFixture('abort');

/** What the Stop fixture's manifest declares beside the files: the free points with their cause, and the cases where Node's own
 *  recordings disagree on what the rule holds exact or last. */
export function abortManifestExtra(recordings) {
  const names = recordings[0].cases.map((c) => c.name);
  return {
    freePoints: {
      snapshots: 'which session snapshots the phone receives: its fanout mailbox drains when the previous frame\'s send settles (remote-relay-session-state.ts:170-175, desktop-service-protocol.ts:61-81), not on a clock',
      rows: 'which roster rows are published: when the daemon\'s summaries reach the host (session-host-catalog.ts:228-240)',
    },
    nodeVariants: Object.fromEntries(names.map((name) => [name, variantsOf(recordings.map((r) => r.cases.find((c) => c.name === name).node))]).filter(([, v]) => v.length)),
  };
}

/** The environment's own folder (each side runs in its own) is the same folder for both. */
export const folders = (value) => JSON.parse(JSON.stringify(value).replace(/[^"]*?env-ph2-chat-abort-(node|live)(\\\\|\/)/g, '<env>/'));

/** A recorded side in the shape `judge` reads: the streams and everything else the phone was handed. */
export const sideOf = (side) => folders({
  stream: side.stream,
  hostStream: side.hostStream ?? [],
  rest: { reply: side.reply ?? null, ...(side.second !== undefined ? { second: side.second } : {}), ...(side.answers ? { answers: side.answers } : {}), items: side.items, row: side.row, promptRestore: side.promptRestore ?? null },
});

/** Where Node's recordings `nodeSides` (raw) of one case disagree among themselves (compare.mjs `nodeVariants`). */
export function variantsOf(nodeSides) {
  const raw = nodeSides.map(sideOf);
  const runOwn = runOwnOf(raw);
  return nodeVariants(raw.map((n) => normalized(n, runOwn)));
}

/** The differences of `side` (raw, Node's or the core's) from Node's recordings `nodeSides` (raw) of the same case. */
export function differences(side, nodeSides) {
  const raw = nodeSides.map(sideOf);
  const runOwn = runOwnOf(raw);
  return judge(normalized(sideOf(side), runOwn), raw.map((n) => normalized(n, runOwn)));
}
