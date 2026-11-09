// The comparison the live replays share: the roster Node's phone published for a scripted action (remote-protocol-chat-roster.recorded.json,
// run from the exact b6f10295a export) against the roster the phone feed publishes from a RUNNING mixdogd's rows and edges
// (remote-protocol-chat-live.recorded.json).
//
// Nothing is filtered: every field of every row, and the order of the rows, is compared. The mapping is representation only:
//   ids        Node's `sess_N` is the live session `made.sess_N` (a room's own id likewise: made.room)
//   folders    Node's `C:\proj\a|b` is the live project folder `projects.a|b`
//   timestamps wall-clock times differ by run, so a Node time is mapped to the live time it first appears with, walking the recorded
//              actions in order, each roster in Node's order, `updatedAt` then `activityAt` of each row (the same Node time must be the
//              same live time afterwards, and the mapping must preserve order).
import assert from 'node:assert/strict';

export const TIME_FIELDS = ['createdAt', 'updatedAt', 'activityAt'];

export function createParity({ live, node, project }) {
  // Node's and the core's runs each made the same named threads (sess_N, agents, the room) under ids of their own.
  const idOf = new Map(Object.entries(node.made).map(([name, id]) => [id, live.made[name]]));
  // A task has no project: Node's run and the core's each keep it in their own task workspace (the core names it itself, project/taskWorkspace).
  const nodeTaskWorkspaces = new Set(node.states.flatMap((state) => state.roster).filter((row) => row.classification === 'task').map((row) => row.cwd));
  assert.equal(nodeTaskWorkspaces.size, 1, 'Node keeps every task in one task workspace');
  const folders = { [node.projects.a]: live.projects.a, [node.projects.b]: live.projects.b, [[...nodeTaskWorkspaces][0]]: live.manifest.taskWorkspace };
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
          firstAt.set(row[field], { title: row.title, field, got });
        }
      }
    }
  });
  const sorted = [...times].sort((a, b) => a[0] - b[0]);
  const unordered = sorted.filter(([, liveTime], at) => at && liveTime <= sorted[at - 1][1]).map(([nodeTime]) => firstAt.get(nodeTime));

  const mapped = (key, value) => {
    if (key === 'id' || key === 'inheritedFromSessionId') return idOf.get(value);
    if (key === 'agentRoom') return { ...value, id: idOf.get(value.id) };
    if (key === 'cwd' || key === 'projectPath') return folders[value] ?? value;
    if (TIME_FIELDS.includes(key)) return times.get(value);
    return value;
  };
  const expectedRow = (row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, mapped(key, value)]));
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const kindOf = (want, got) => (got === undefined ? 'missing' : want === undefined ? 'extra' : 'value');

  return {
    /** The Node times whose live time breaks Node's order of times. */
    timeOrderBreaks: () => unordered.map(({ title, field }) => `${title}.${field}`),
    /** Every difference between Node's roster and the phone's rows (each row's every field, and the rows' order), as `<title>.<field>` paths. */
    classify(nodeRoster, phoneRows) {
      const got = byTitle(phoneRows);
      const want = byTitle(nodeRoster.map(expectedRow));
      const differences = [];
      for (const title of new Set([...want.keys(), ...got.keys()])) {
        const a = want.get(title);
        const b = got.get(title);
        if (!a || !b) { differences.push(`${title}.row`); continue; }
        for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
          if (!same(a[key], b[key])) differences.push(`${title}.${key}: ${JSON.stringify(a[key])} != ${JSON.stringify(b[key])}`);
        }
      }
      if (!same(nodeRoster.map((row) => row.title), phoneRows.map((row) => row.title))) differences.push('order');
      return differences;
    },
  };
}

/** Fails on any difference from Node. */
export function assertParity(t, differences) {
  assert.deepEqual(differences, [], 'differences from Node');
}