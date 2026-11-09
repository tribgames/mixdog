// The comparison the live replays share: the roster Node's phone published for a scripted action (remote-protocol-chat-roster.recorded.json,
// run from the exact b6f10295a export) against the roster the phone feed publishes from a RUNNING mixdogd's rows and edges
// (remote-protocol-chat-live.recorded.json).
//
// Nothing is filtered: every field of every row, and the order of the rows, is compared. The mapping is representation only:
//   ids        Node's `sess_N` is the live session `made.sess_N`
//   folders    Node's `C:\proj\a|b` is the live project folder `projects.a|b`
//   timestamps wall-clock times differ by run, so a Node time is mapped to the live time it first appears with, walking the recorded
//              actions in order, each roster in Node's order, `updatedAt` then `activityAt` of each row (the same Node time must be the same
//              live time afterwards, and the mapping must preserve order). The paths this covers: <title>.updatedAt, <title>.activityAt.
import assert from 'node:assert/strict';

export const TIME_FIELDS = ['updatedAt', 'activityAt'];

// What mixdogd's rows do not match yet, as field paths: exactly these differences are todo until branch rs-thread-list-rows (the Rust
// worker's, C:\Users\tempe\side\pool\w17) lands. Any other difference fails the test.
export const RUST_GAP = 'branch rs-thread-list-rows: the core\'s thread rows lack roster fields (read cursor, favorite, createdAt), a fork lands in the task workspace with its parent\'s times, and a rename moves updatedAt away from activityAt';
const GAP_FIELDS = new Set(['readMessageCount', 'readRevision', 'favorite', 'createdAt', 'updatedAt', 'activityAt', 'order']);
const FORK_FIELDS = new Set(['cwd', 'classification', 'projectPath']);
export const isGap = (diff) => {
  const [title, field] = diff.split('.');
  return GAP_FIELDS.has(field ?? title) || (title === 'Title 2' && FORK_FIELDS.has(field));
};

/** Fails on any difference that is not a known gap; a known gap marks the test todo (and still asserts equality). */
export function assertParity(t, diffs) {
  const unexpected = diffs.filter((diff) => !isGap(diff));
  assert.deepEqual(unexpected, [], 'differences from Node that are not a known gap');
  if (diffs.length) t.todo(RUST_GAP);
  assert.deepEqual(diffs, []);
}

export function createParity({ live, node, project }) {
  const idOf = new Map(Object.entries(live.made));
  const folders = { 'C:\\proj\\a': live.projects.a, 'C:\\proj\\b': live.projects.b };
  const byTitle = (rows) => new Map(rows.map((row) => [row.title, row]));

  const times = new Map();
  const firstAt = new Map();
  node.manifest.actions.forEach((name, at) => {
    const liveRows = byTitle(project(live.steps[at].listed.data));
    for (const row of node.states[at + 1].roster) {
      for (const field of TIME_FIELDS) {
        const got = liveRows.get(row.title)?.[field];
        if (typeof got === 'number' && !times.has(row[field])) {
          times.set(row[field], got);
          firstAt.set(row[field], `${row.title}.${field}`);
        }
      }
    }
  });
  const sorted = [...times].sort((a, b) => a[0] - b[0]);
  const unordered = sorted.filter(([, liveTime], at) => at && liveTime <= sorted[at - 1][1]).map(([nodeTime]) => firstAt.get(nodeTime));

  const mapped = (key, value) => {
    if (key === 'id' || key === 'inheritedFromSessionId') return idOf.get(value);
    if (key === 'cwd' || key === 'projectPath') return folders[value];
    if (TIME_FIELDS.includes(key)) return times.get(value);
    return value;
  };
  const expectedRow = (row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, mapped(key, value)]));
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  return {
    /** The paths whose time the mapping would have to put out of Node's order (none when the live times keep Node's order). */
    timeOrderBreaks: () => unordered,
    /** Every difference between Node's roster and the phone's rows (both in their own order), as `<title>.<field>` paths. */
    diff(nodeRoster, phoneRows) {
      const got = byTitle(phoneRows);
      const want = byTitle(nodeRoster.map(expectedRow));
      const out = [];
      for (const title of new Set([...want.keys(), ...got.keys()])) {
        const a = want.get(title);
        const b = got.get(title);
        if (!a || !b) { out.push(`${title}.row`); continue; }
        for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) if (!same(a[key], b[key])) out.push(`${title}.${key}`);
      }
      if (!same(nodeRoster.map((row) => row.title), phoneRows.map((row) => row.title))) out.push('order');
      return out;
    },
  };
}
