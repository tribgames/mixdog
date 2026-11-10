// How a case the core ran is compared with Node's recordings of it. Nothing is listed by hand:
//  - The run-own paths are COMPUTED: the leaf paths (array positions written `[]`, so `stream[].row.updatedAt` is one path and
//    `stream[].snapshot.items[].id` another) whose values differ between two recordings of Node's own code on the same case. A path
//    that never differed between Node's runs is compared exactly, whatever its key is called.
//  - At a run-own path a value is compared by its type and by its relationships: every string there is renamed by first occurrence
//    (`<s1>`, `<s2>`, …, one table per side and case), so a value that recurs must recur at the same places on both sides and two
//    distinct values never collapse into one; a number keeps only its type.
//  - The ordered stream of what the phone was told is compared whole; Node's own recordings of a case may order it differently
//    (pushes that race), and exactly the orders Node showed are admitted: the core's stream must equal one of them.

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Every leaf of `value` as [path, leaf]; an empty array or object is a leaf of its own. */
export function leaves(value, path = '$', out = []) {
  if (Array.isArray(value)) {
    if (!value.length) out.push([path, value]);
    value.forEach((v) => leaves(v, `${path}[]`, out));
  } else if (isObj(value)) {
    const keys = Object.keys(value);
    if (!keys.length) out.push([path, value]);
    for (const k of keys) leaves(value[k], `${path}.${k}`, out);
  } else out.push([path, value]);
  return out;
}

/** The paths at which two recordings of the same case differ, position by position: a value that differs, or that one side has
 *  where the other has none. */
export function varyingPaths(a, b) {
  const out = new Set();
  const walk = (x, y, path) => {
    if (Array.isArray(x) && Array.isArray(y)) {
      for (let i = 0; i < Math.max(x.length, y.length); i++) {
        if (i >= x.length) leaves(y[i], `${path}[]`).forEach(([p]) => out.add(p));
        else if (i >= y.length) leaves(x[i], `${path}[]`).forEach(([p]) => out.add(p));
        else walk(x[i], y[i], `${path}[]`);
      }
    } else if (isObj(x) && isObj(y)) {
      for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) {
        if (!(k in x)) leaves(y[k], `${path}.${k}`).forEach(([p]) => out.add(p));
        else if (!(k in y)) leaves(x[k], `${path}.${k}`).forEach(([p]) => out.add(p));
        else walk(x[k], y[k], `${path}.${k}`);
      }
    } else if (JSON.stringify(x) !== JSON.stringify(y)) {
      leaves(x, path).forEach(([p]) => out.add(p));
      leaves(y, path).forEach(([p]) => out.add(p));
    }
  };
  walk(a, b, '$');
  return out;
}

/** `value` with every leaf at a run-own path replaced: strings by their first-occurrence number in `names` (shared by everything one
 *  side of one case holds), other values by their type. Everything else is kept as it is. */
export function canonical(value, runOwn, names = new Map(), path = '$') {
  if (Array.isArray(value)) return value.map((v) => canonical(v, runOwn, names, `${path}[]`));
  // Keys are visited in sorted order: the order an object's keys were written in means nothing, and the numbering must not depend on it.
  if (isObj(value)) return Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => [k, canonical(v, runOwn, names, `${path}.${k}`)]));
  if (!runOwn.has(path)) return value;
  if (typeof value !== 'string') return `<${value === null ? 'null' : typeof value}>`;
  if (!names.has(value)) names.set(value, `<s${names.size + 1}>`);
  return names.get(value);
}

/** The order of a stream: the kind (and the call, for a reply) of each thing told. */
export const streamOrder = (stream) => (stream ?? []).map((e) => (e.kind === 'reply' ? `reply:${e.method}` : e.kind)).join(',');

// ---------------------------------------------------------------------------------------------------------------------------------
// The rule over N recordings of Node (the decision of the phone-chat-live review: "only what Node's recordings show").
//
// Free points (declared in the recordings' manifest): which session snapshots a phone receives depends on when its fanout's mailbox
// drains, and that is when the previous frame's send settles (remote-relay-session-state.ts:170-175 `.finally(() => mailbox.acknowledge)`,
// desktop-service-protocol.ts:61-81 `createLatestStateMailbox`), not on a clock; which rows the roster publishes depends on when the
// daemon's summaries reach the host (session-host-catalog.ts:228-240). So snapshots and rows are COALESCED messages; everything else
// (the replies to the phone's calls, with their errors) is EXACT.
//
//  - Run-own paths are computed from the N recordings: a leaf path (per message kind) is run-own when two recordings each show a
//    value there the other never shows (a time, an id, a pid). A value one recording shows and another lacks only because a message
//    was coalesced away makes one side a superset, not both: that path stays exact. At a run-own path a string is renamed by first
//    occurrence within the case (relationships kept), a number keeps its type (`canonical`).
//  - A coalesced message the core's phone receives must have a content some Node recording's host published, in that kind.
//  - For any two distinct coalesced contents A, B: the core shows A before B only if some Node recording (host or phone) does.
//  - The last snapshot and the last row equal Node's (the same in every recording, or the case is reported).
//  - The exact messages: the same in every Node recording, and the core's equal to them, in order.
//  - An exact message and a coalesced content: their relative order only as some Node recording shows it.

export const COALESCED = new Set(['state', 'row']);
const kindOf = (e) => (e.kind === 'reply' ? `reply:${e.method}` : e.kind);
const bodyOf = (e) => (e.kind === 'state' ? e.snapshot : e.kind === 'row' ? e.row : e);

/** The run-own paths of N recordings of one case (each `{ stream, hostStream, rest }`). */
export function runOwnOf(recordings) {
  const valueSets = recordings.map((r) => {
    const sets = new Map();
    const add = (path, value) => { if (!sets.has(path)) sets.set(path, new Set()); sets.get(path).add(JSON.stringify(value)); };
    for (const e of [...r.stream, ...r.hostStream]) leaves(bodyOf(e), `$${kindOf(e)}`).forEach(([p, v]) => add(p, v));
    leaves(r.rest, '$rest').forEach(([p, v]) => add(p, v));
    return sets;
  });
  const out = new Set();
  for (let i = 0; i < valueSets.length; i++) {
    for (let j = i + 1; j < valueSets.length; j++) {
      for (const path of new Set([...valueSets[i].keys(), ...valueSets[j].keys()])) {
        const a = valueSets[i].get(path) ?? new Set();
        const b = valueSets[j].get(path) ?? new Set();
        if ([...a].some((v) => !b.has(v)) && [...b].some((v) => !a.has(v))) out.add(path);
      }
    }
  }
  return out;
}

/** One side of a case in comparable form: every message's content key under the run-own paths. Each message has its own renaming
 *  table: which messages a phone sees is free, so an id's first appearance across messages is not a fact of the run; within one
 *  message every relationship between ids is kept. */
export function normalized(side, runOwn) {
  const one = (e) => {
    const kind = kindOf(e);
    return { kind, coalesced: COALESCED.has(e.kind), key: JSON.stringify(canonical(bodyOf(e), runOwn, new Map(), `$${kind}`)) };
  };
  return { stream: side.stream.map(one), hostStream: (side.hostStream ?? []).map(one), rest: JSON.stringify(canonical(side.rest, runOwn, new Map(), '$rest')) };
}

/** The order relations a stream shows: `a<b` for every a before b (coalesced contents and exact messages by their index). */
function relations(stream) {
  const labels = [];
  let exact = 0;
  for (const m of stream) labels.push(m.coalesced ? `c:${m.key}` : `x:${exact++}:${m.key}`);
  const out = new Set();
  for (let i = 0; i < labels.length; i++) for (let j = i + 1; j < labels.length; j++) if (labels[i] !== labels[j]) out.add(`${labels[i]}\u0000${labels[j]}`);
  return out;
}

/** Where Node's own recordings of a case disagree on what the rule would otherwise hold exact: the case is reported with these. */
export function nodeVariants(nodes) {
  const out = [];
  const count = (f) => new Set(nodes.map(f)).size;
  if (count((n) => JSON.stringify(n.stream.filter((m) => !m.coalesced).map((m) => m.key))) > 1) out.push('exact messages');
  if (count((n) => n.rest) > 1) out.push('reply, transcript, row or prompt handed back');
  for (const kind of COALESCED) if (count((n) => n.stream.filter((m) => m.kind === kind).at(-1)?.key ?? null) > 1) out.push(`last ${kind}`);
  return out;
}

/** The differences of `core` (one normalized side) from the normalized Node recordings `nodes` of the same case, as messages. */
export function judge(core, nodes) {
  const problems = [];
  const exactOf = (s) => s.stream.filter((m) => !m.coalesced).map((m) => m.key);
  // Where Node's recordings disagree among themselves (`nodeVariants` reports it), the core's must be one of Node's.
  const nodeExact = new Set(nodes.map((n) => JSON.stringify(exactOf(n))));
  if (!nodeExact.has(JSON.stringify(exactOf(core)))) problems.push(`the exact messages differ: core ${JSON.stringify(exactOf(core))} Node ${[...nodeExact].join(' | ')}`);
  const nodeRest = new Set(nodes.map((n) => n.rest));
  if (!nodeRest.has(core.rest)) problems.push(`the replies, transcript, list row or prompt handed back differ: core ${core.rest} Node ${[...nodeRest].join(' | ')}`);
  const published = new Set(nodes.flatMap((n) => [...n.hostStream, ...n.stream].filter((m) => m.coalesced).map((m) => `${m.kind}\u0000${m.key}`)));
  for (const m of core.stream.filter((x) => x.coalesced)) if (!published.has(`${m.kind}\u0000${m.key}`)) problems.push(`a ${m.kind} Node never published: ${m.key}`);
  // The last snapshot and row: Node's own when they are the same in every recording. Where Node's recordings end on different ones (a
  // race in Node itself, `lastVariants` reports the cases), the core's must be one of them.
  for (const kind of COALESCED) {
    const lastOf = (s) => s.stream.filter((m) => m.kind === kind).at(-1)?.key ?? null;
    const nodeLast = new Set(nodes.map(lastOf));
    if (!nodeLast.has(lastOf(core))) problems.push(`the last ${kind} is none of Node's: core ${lastOf(core)} Node ${[...nodeLast].join(' | ')}`);
  }
  const seen = new Set(nodes.flatMap((n) => [...relations(n.hostStream), ...relations(n.stream)]));
  for (const r of relations(core.stream)) {
    if (!seen.has(r)) {
      const [a, b] = r.split('\u0000');
      // A content Node never published is already a difference of its own; its order is not reported again.
      const unpublished = (label) => label.startsWith('c:') && ![...COALESCED].some((kind) => published.has(`${kind}\u0000${label.slice(2)}`));
      if (unpublished(a) || unpublished(b)) continue;
      problems.push(`an order Node never showed: ${a.slice(0, 300)} BEFORE ${b.slice(0, 300)}`);
    }
  }
  return problems;
}

/** The run-own paths of a case: those any two of Node's recordings of it differ at. Two streams are aligned position by position only
 *  when they are in the same order; recordings whose streams are in different orders give their run-own paths outside the stream only. */
export function runOwnPaths(recordings) {
  const out = new Set();
  for (let i = 0; i < recordings.length; i++) {
    for (let j = i + 1; j < recordings.length; j++) {
      const [a, b] = [recordings[i], recordings[j]];
      const sameOrder = streamOrder(a.stream) === streamOrder(b.stream);
      const strip = ({ stream: _s, ...rest }) => rest;
      varyingPaths(sameOrder ? a : strip(a), sameOrder ? b : strip(b)).forEach((p) => out.add(p));
    }
  }
  return out;
}
