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
  // Rows are paired by position, never through a field that can repeat (two threads may share a title): Node's i-th row is the phone's i-th.
  const times = new Map();
  const firstAt = new Map();
  node.manifest.actions.forEach((name, at) => {
    const liveRows = project(live.steps[at].listed.data);
    for (const [index, row] of node.states[at + 1].roster.entries()) {
      for (const field of TIME_FIELDS) {
        const got = liveRows[index]?.[field];
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

  /** A roster's content with its times kept by type only: a publication between two actions carries times no settled roster maps. */
  const timeless = (row) => Object.fromEntries(Object.entries(row).sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, value]) => [key, TIME_FIELDS.includes(key) ? typeof value : value]));

  return {
    /** Node's roster `rows` (ids and folders mapped to the live run's) as content, its times by type. */
    nodeContent: (rows) => JSON.stringify(rows.map((row) => timeless(Object.fromEntries(Object.entries(row).map(([key, value]) => [key, TIME_FIELDS.includes(key) ? value : mapped(key, value)]))))),
    /** The phone's roster `rows` as content, its times by type. */
    phoneContent: (rows) => JSON.stringify(rows.map(timeless)),
    /** The Node times whose live time breaks Node's order of times. */
    timeOrderBreaks: () => unordered.map(({ title, field }) => `${title}.${field}`),
    /** Every difference between Node's roster and the phone's rows, row by row in order (each row's every field, its id included),
     *  as `<index>:<title>.<field>` paths; a row one side lacks is `<index>:<title>.row`. */
    classify(nodeRoster, phoneRows) {
      const want = nodeRoster.map(expectedRow);
      const differences = [];
      for (let index = 0; index < Math.max(want.length, phoneRows.length); index++) {
        const a = want[index];
        const b = phoneRows[index];
        if (!a || !b) { differences.push(`${index}:${(a ?? b).title}.row`); continue; }
        for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
          if (!same(a[key], b[key])) differences.push(`${index}:${a.title}.${key}: ${JSON.stringify(a[key])} != ${JSON.stringify(b[key])}`);
        }
      }
      return differences;
    },
  };
}

/** Fails on any difference from Node. */
export function assertParity(t, differences) {
  assert.deepEqual(differences, [], 'differences from Node');
}