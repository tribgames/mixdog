// The comparison the live replays share: the roster Node's phone published for a scripted action (remote-protocol-chat-roster.recorded.json,
// run from the exact b6f10295a export) against the roster the phone feed publishes from a RUNNING mixdogd's rows and edges
// (remote-protocol-chat-live.recorded.json).
//
// Nothing is filtered: every field of every row, and the order of the rows, is compared. The mapping is representation only:
//   ids        Node's `sess_N` is the live session `made.sess_N`
//   folders    Node's `C:\proj\a|b` is the live project folder `projects.a|b`
//   timestamps wall-clock times differ by run, so a Node time is mapped to the live time it first appears with, walking the recorded
//              actions in order, each roster in Node's order, `updatedAt` then `activityAt` of each row (the same Node time must be the
//              same live time afterwards, and the mapping must preserve order).
import assert from 'node:assert/strict';

export const TIME_FIELDS = ['updatedAt', 'activityAt'];

export const RUST_GAP = 'branch rs-thread-list-rows: the core\'s thread rows lack roster fields (read cursor, favorite, createdAt), a fork lands in the task workspace with its parent\'s times, and a rename moves updatedAt away from activityAt';

/**
 * A difference is a known gap only if it is exactly one of these, each a predicate over (row, field, kind of difference, the values on
 * both sides, the recorded core rows). `kind` is 'missing' (Node's row has the field, the core's has none), 'extra' (the core's has one Node's
 * lacks) or 'value' (both have it and they differ). Anything else, including a wrong value where a field is merely missing, fails.
 */
function gapPredicates({ createdRows, taskWorkspace }) {
  const parent = createdRows.get('Title 0');
  return [
    // The core's list rows have no read cursor: only Title 1 has one in the scenario, and it is absent, not different.
    ({ title, field, kind }) => title === 'Title 1' && (field === 'readMessageCount' || field === 'readRevision') && kind === 'missing',
    // The core's list rows have no favorite: only the fork (Title 2) is a favorite, and the field is absent, not different.
    ({ title, field, kind }) => title === 'Title 2' && field === 'favorite' && kind === 'missing',
    // The core's list rows have no creation time.
    ({ field, kind }) => field === 'createdAt' && kind === 'missing',
    // Fork placement: the fork is made in the task workspace (task, no project) where Node keeps it in its parent's project.
    ({ title, field, kind, got }) =>
      title === 'Title 2' &&
      ((field === 'classification' && kind === 'value' && got === 'task') ||
        (field === 'projectPath' && (kind === 'missing' || (kind === 'value' && got === null))) ||
        (field === 'cwd' && kind === 'value' && got === taskWorkspace)),
    // Fork times: the core's fork carries its parent's creation times where Node stamps the fork with its own creation tick.
    ({ title, field, kind, got }) => title === 'Title 2' && TIME_FIELDS.includes(field) && kind === 'value' && got === parent[field],
    // A rename moves the core's updatedAt away from activityAt (Node's rename is sidebar metadata and writes nothing to the session): the row
    // keeps its creation activityAt while Node's one time maps to the moved updatedAt, and nothing has written the row since the rename.
    ({ title, field, kind, got, want, row }) =>
      field === 'activityAt' && kind === 'value' && got < row.updatedAt && want === row.updatedAt &&
      row.updatedAt === createdRows.get(title)?.updatedAt && got === createdRows.get(title)?.activityAt,
  ];
}

export function createParity({ live, node, project }) {
  const idOf = new Map(Object.entries(live.made));
  const folders = { 'C:\\proj\\a': live.projects.a, 'C:\\proj\\b': live.projects.b };
  const byTitle = (rows) => new Map(rows.map((row) => [row.title, row]));
  const createdRows = byTitle(project(live.steps[0].listed.data));
  // The exact task-workspace path of the live run, as the core itself named it when it was recorded (project/taskWorkspace).
  const predicates = gapPredicates({ createdRows, taskWorkspace: live.manifest.taskWorkspace });

  const times = new Map();
  const firstAt = new Map();
  node.manifest.actions.forEach((name, at) => {
    const liveRows = byTitle(project(live.steps[at].listed.data));
    for (const row of node.states[at + 1].roster) {
      for (const field of TIME_FIELDS) {
        const got = liveRows.get(row.title)?.[field];
        if (typeof got === 'number' && !times.has(row[field])) {
          times.set(row[field], got);
          firstAt.set(row[field], { title: row.title, field, got });
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
  const kindOf = (want, got) => (got === undefined ? 'missing' : want === undefined ? 'extra' : 'value');
  const isGap = (entry) => predicates.some((gap) => gap(entry));

  return {
    /** The Node times whose live time breaks Node's order of times, classified like any other difference. */
    timeOrderBreaks() {
      const entries = unordered.map(({ title, field, got }) => ({ title, field, kind: 'value', got, path: `${title}.${field}` }));
      const gaps = entries.filter((entry) => TIME_FIELDS.includes(entry.field) && entry.title === 'Title 2' && entry.got === createdRows.get('Title 0')[entry.field]);
      return { gaps: gaps.map((e) => e.path), unexpected: entries.filter((e) => !gaps.includes(e)).map((e) => e.path) };
    },
    /**
     * Every difference between Node's roster and the phone's rows, as `<title>.<field>` paths, split into the known gaps and the rest.
     * The order is a gap only when it is exactly what the gap time differences make of Node's order: Node's rows with the core's times for
     * the rows whose time is a gap, in Node's catalog order (activity descending, then id), are the phone's order.
     */
    classify(nodeRoster, phoneRows) {
      const got = byTitle(phoneRows);
      const wantRows = nodeRoster.map(expectedRow);
      const want = byTitle(wantRows);
      const gaps = [];
      const unexpected = [];
      const timeGaps = new Set();
      for (const title of new Set([...want.keys(), ...got.keys()])) {
        const a = want.get(title);
        const b = got.get(title);
        if (!a || !b) { unexpected.push(`${title}.row`); continue; }
        for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
          if (same(a[key], b[key])) continue;
          const entry = { title, field: key, kind: kindOf(a[key], b[key]), want: a[key], got: b[key], row: b, path: `${title}.${key}` };
          (isGap(entry) ? gaps : unexpected).push(entry.path);
          if (isGap(entry) && TIME_FIELDS.includes(key)) timeGaps.add(title);
        }
      }
      if (!same(nodeRoster.map((row) => row.title), phoneRows.map((row) => row.title))) {
        const substituted = wantRows
          .map((row) => (timeGaps.has(row.title) ? { ...row, activityAt: got.get(row.title).activityAt } : row))
          .sort((x, y) => y.activityAt - x.activityAt || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
        (timeGaps.size && same(substituted.map((row) => row.title), phoneRows.map((row) => row.title)) ? gaps : unexpected).push('order');
      }
      return { gaps, unexpected };
    },
  };
}

/** Fails on any difference that is not a known gap; known gaps alone mark the test todo (and the equality is still asserted). */
export function assertParity(t, { gaps, unexpected }) {
  assert.deepEqual(unexpected, [], 'differences from Node that are not a known gap');
  if (gaps.length) t.todo(RUST_GAP);
  assert.deepEqual(gaps, []);
}
