import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';

registerHooks({
  resolve(specifier, context, next) {
    return specifier === 'electron'
      ? {
          url:
            'data:text/javascript,' +
            encodeURIComponent(`
        export const BrowserWindow = { getAllWindows: () => [] };
        export const desktopCapturer = { getSources: async () => [] };
        export const nativeImage = { createFromBuffer: () => ({}) };
        export const screen = { getDisplayMatching: () => ({ scaleFactor: 1 }) };
      `),
          shortCircuit: true,
        }
      : next(specifier, context);
  },
});
const { createCaptureEngine } = await import('./capture.ts');
const { recordObservation } = await import('./capture-delta.ts');
const { createSessionState } = await import('../session/state.ts');
const { createExecutionState } = await import('../host/execution-state.ts');
const { DEFAULT_CAPTURE_MAX_ELEMENTS } = await import('../shared/common.ts');
const { canonicalComputerResultText } = await import('../../../../../../src/runtime/computer-bridge/result-canonical.mjs');

const WINDOW = 'hwnd:0x1';
const PERMISSIONS = {
  screen_capture: 'not_required_on_windows',
  accessibility: 'not_required_on_windows',
  input: 'target_integrity_dependent',
};
const WORDS = ['File', 'Edit', 'View', 'Save', 'Open', 'Close', 'Search', 'Settings', 'Help', 'Refresh', 'Share', 'Copy'];
const ROLES = ['Button', 'MenuItem', 'ListItem', 'CheckBox', 'Hyperlink', 'TabItem'];

/** A tree the way the worker reports it: refs are `s<generation>:e<index>`. */
function treeRows(count) {
  return Array.from({ length: count }, (_, index) => ({
    role: ROLES[index % ROLES.length],
    name: `${WORDS[index % WORDS.length]} ${Math.floor(index / WORDS.length) + 1}`,
    y: 20 * index,
  }));
}

function snapshotResult(world) {
  return {
    window_id: world.windowId,
    generation: world.generation,
    total_elements: world.rows.length,
    elements: world.rows.map((row, index) => ({
      mark: index + 1,
      ref: `s${world.generation}:e${index}`,
      source: 'uia',
      role: row.role,
      name: row.name,
      value: row.value ?? '',
      state: row.state ?? '',
      enabled: row.enabled ?? true,
      x: 10,
      y: row.y ?? 20 * index,
      width: 120,
      height: 18,
      center_x: 70,
      center_y: (row.y ?? 20 * index) + 9,
      actions: ['click', 'invoke'],
    })),
  };
}

function fixture(rows) {
  const world = { generation: 0, windowId: WINDOW, rows, advance: 2 };
  const bounds = {
    window_id: WINDOW,
    x: 0,
    y: 0,
    width: 800,
    height: 600,
    client_x: 0,
    client_y: 0,
    client_width: 800,
    client_height: 600,
    related_window_ids: [WINDOW],
  };
  const callPowerShell = async (request) => {
    if (request.action === 'input_idle_state')
      return { ok: true, result: { observer_ready: true, monitor: 'worker-a', sequence: 3 } };
    if (request.action === 'window_bounds') return { ok: true, result: bounds };
    if (request.action === 'snapshot') {
      // An action retires the refs once and the observation's snapshot again.
      world.generation += world.advance;
      return { ok: true, result: snapshotResult(world) };
    }
    throw new Error(`unexpected fixture request: ${request.action}`);
  };
  const state = createSessionState({ callPowerShell });
  const execution = createExecutionState();
  const active = { sessionId: 'a', aborted: false };
  execution.activeExecutionsBySession.set('a', active);
  const capture = createCaptureEngine({
    ...state,
    ...execution,
    callPowerShell,
    nativeSurfaceBackends: [],
    readPermissions: () => PERMISSIONS,
  });
  const run = (operation) => execution.executionContext.run(active, operation);
  const click = { action: 'click', ref: 'held', window_id: WINDOW, session_id: 'a', capture_after_mode: 'ax' };
  const after = (options) => run(() => capture.captureAfterAction(click, WINDOW, 0, 0, options));
  // The command as it reaches the worker: the host must never change a ref.
  const resolve = (command) => state.resolveElementAliases({ session_id: 'a', action: 'invoke', ...command });
  return { world, state, capture, run, after, resolve };
}

const refs = (rows) => rows.map((row) => row.ref);

/** `s2:e7..e29=s4:e6..e28` runs → Map(held ref → live ref). */
function expandRuns(runs) {
  const range = (text) => {
    const match = /^(.+:e)(\d+)(?:\.\.e(\d+))?$/.exec(text);
    const from = Number(match[2]);
    const to = match[3] === undefined ? from : Number(match[3]);
    return Array.from({ length: to - from + 1 }, (_, offset) => `${match[1]}${from + offset}`);
  };
  const pairs = new Map();
  for (const run of runs) {
    const [held, live] = run.split('=').map(range);
    assert.equal(held.length, live.length, run);
    held.forEach((ref, index) => pairs.set(ref, live[index]));
  }
  return pairs;
}

/** Every ref the model holds is accounted for exactly once: paired or removed. */
function assertAccountsForEveryRef(delta, held) {
  const paired = expandRuns(delta.unchanged);
  const removed = delta.removed ?? [];
  for (const ref of held) assert.equal(paired.has(ref) + removed.includes(ref), 1, `${ref} accounted for once`);
  assert.equal(paired.size + removed.length, held.length);
  return paired;
}

test('an unchanged window answers unchanged with the live ref of every row', async () => {
  const f = fixture(treeRows(40));
  const first = await f.after();
  assert.equal(first.metadata.elements.length, 40);
  assert.equal(first.metadata.elements_delta, undefined);
  const held = refs(first.metadata.elements);

  const second = await f.after();
  assert.deepEqual(second.metadata.elements_delta, { unchanged: [`s2:e0..e39=s4:e0..e39`] });
  assert.equal(second.metadata.elements, undefined);
  assert.equal(second.metadata.returned_elements, 40);
  assertAccountsForEveryRef(second.metadata.elements_delta, held);
});

test('an add, a removal and an update produce exactly that delta', async () => {
  const f = fixture(treeRows(30));
  const held = refs((await f.after()).metadata.elements);
  const rows = treeRows(30);
  f.world.rows = [
    ...rows.slice(0, 5),
    { ...rows[5], value: 'on' }, // updated
    ...rows.slice(7), // rows[6] removed
    { role: 'Button', name: 'Brand new', y: 900 }, // added at the end
  ];

  const { elements_delta: delta, elements } = (await f.after()).metadata;
  assert.equal(elements, undefined);
  assert.deepEqual(delta.unchanged, ['s2:e0..e4=s4:e0..e4', 's2:e7..e29=s4:e6..e28']);
  assert.deepEqual(delta.removed, [held[5], held[6]], 'an updated row is its old ref removed and its new row listed');
  assert.deepEqual(
    delta.added.map((row) => [row.name, row.value ?? '', row.ref, row.mark]),
    [
      [rows[5].name, 'on', 's4:e5', undefined],
      ['Brand new', '', 's4:e29', undefined],
    ]
  );
  assertAccountsForEveryRef(delta, held);
});

test('the host never rewrites a ref: every retired ref reaches the worker as sent, to be refused as stale', async () => {
  const f = fixture(treeRows(30));
  const held = refs((await f.after()).metadata.elements);
  const rows = treeRows(30);
  f.world.rows = [...rows.slice(0, 10), { role: 'Button', name: 'Extra one', y: 900 }, ...rows.slice(10, 29)];
  const second = (await f.after()).metadata.elements_delta;
  const extra = second.added[0].ref;
  f.world.rows = rows.slice(0, 20);
  const third = (await f.after()).metadata.elements_delta;
  assert.ok(third.removed.length > 0);

  const live = (index) => `s${f.world.generation}:e${index}`;
  for (const ref of [...held, extra, 's999:e0', 'not-a-ref']) {
    const command = f.resolve({ ref, to: held[3] });
    assert.equal(command.ref, ref);
    assert.equal(command.to, held[3]);
  }
  // The model reaches an unchanged row through the live ref the delta named, in the
  // same generation the worker accepts.
  const paired = expandRuns(third.unchanged);
  // Its left side is the list the second reply left the model with (generation 4).
  assert.equal(paired.get('s4:e3'), live(3));
  assert.equal(paired.get('s4:e12'), live(11));
  assert.equal(paired.has(held[3]), false, 'the first list is no longer addressed');
  assert.equal(f.resolve({ ref: live(2) }).ref, live(2));
  assert.throws(() => f.resolve({ ref: 'ocr:7:3' }), /stale_element/);
});

// Two identical rows: nothing the model can see tells them apart.
const twin = (y = 300) => ({ role: 'ListItem', name: 'Untitled', y });

test('removing one of two identical rows never pairs a held ref with a sibling', async () => {
  const f = fixture([...treeRows(10), twin(), twin()]);
  const held = refs((await f.after()).metadata.elements);
  const [a, b] = [held[10], held[11]];
  f.world.rows = [...treeRows(10), twin()];

  const delta = (await f.after()).metadata.elements_delta;
  const paired = assertAccountsForEveryRef(delta, held);
  assert.equal(paired.has(a), false, 'the removed twin is not paired');
  assert.equal(paired.has(b), false, 'and neither is the survivor, which cannot be told from it');
  assert.deepEqual(delta.removed, [a, b]);
  assert.equal(delta.added.length, 1, 'the remaining row is listed again with its live ref');
  const live = `s${f.world.generation}:e10`;
  assert.equal(delta.added[0].ref, live);
  // Invoking the removed twin reaches the worker with its own ref, which it refuses as stale.
  assert.equal(f.resolve({ ref: a }).ref, a);
  assert.notEqual(f.resolve({ ref: a }).ref, live);
});

test('a RuntimeId reused by a lookalike never revives the destroyed element: its ref is refused, not translated', async () => {
  // The worker reports no id the host trusts; the replacement renders exactly like the original.
  const f = fixture([...treeRows(10), { role: 'Button', name: 'Delete', y: 300 }]);
  const held = refs((await f.after()).metadata.elements);
  const original = held[10];
  f.world.rows = [...treeRows(10), { role: 'Button', name: 'Delete', y: 300 }];

  const delta = (await f.after()).metadata.elements_delta;
  const live = `s${f.world.generation}:e10`;
  assert.equal(f.resolve({ ref: original }).ref, original, 'never translated to the lookalike');
  assert.notEqual(original, live);
  // What the model is told is only that an identical row now has the live ref.
  assert.equal(expandRuns(delta.unchanged).get(original), live);
  assert.match(original, /^s2:/, 'and the original ref belongs to a retired generation');
});

test('reordered rows are paired by what they render, never by position', async () => {
  const f = fixture([...treeRows(10), twin(300), twin(320)]);
  const held = refs((await f.after()).metadata.elements);
  f.world.rows = [...treeRows(10), twin(320), twin(300)];
  const delta = (await f.after()).metadata.elements_delta;
  const paired = assertAccountsForEveryRef(delta, held);
  const live = (index) => `s${f.world.generation}:e${index}`;
  // The twin at y=300 is live index 11 now and the one at y=320 is index 10.
  if (paired.has(held[10])) assert.equal(paired.get(held[10]), live(11));
  if (paired.has(held[11])) assert.equal(paired.get(held[11]), live(10));
  assert.equal(delta.removed.length, 1, 'only one of the two can keep its place in the list');
  assert.equal(delta.added.length, 1);
  for (const ref of [held[10], held[11]]) assert.equal(f.resolve({ ref }).ref, ref);

  // Reordered twins that render identically cannot be told apart at all.
  const g = fixture([...treeRows(10), twin(300), twin(300)]);
  const heldG = refs((await g.after()).metadata.elements);
  g.world.rows = [...treeRows(10), twin(300), twin(300), { role: 'Button', name: 'More', y: 700 }];
  const same = (await g.after()).metadata.elements_delta;
  const pairedG = assertAccountsForEveryRef(same, heldG);
  assert.equal(pairedG.size, 10);
  assert.deepEqual(same.removed, [heldG[10], heldG[11]]);
});

test('a twin whose sibling changed is still not paired with it', async () => {
  const f = fixture([...treeRows(10), twin(300), twin(300)]);
  const held = refs((await f.after()).metadata.elements);
  f.world.rows = [...treeRows(10), twin(300), { ...twin(300), value: 'edited' }];
  const delta = (await f.after()).metadata.elements_delta;
  const paired = assertAccountsForEveryRef(delta, held);
  assert.equal(paired.has(held[10]) || paired.has(held[11]), false);
  assert.equal(delta.added.length, 2);
});

test('a session mutation keeps what the model holds, while every invalidation of refs drops it', async () => {
  const f = fixture(treeRows(20));
  await f.after();
  assert.ok((await f.after()).metadata.elements_delta);

  // A mutation clears the element targets before the observation that follows it.
  f.state.elementTargetsBySession.delete('a');
  assert.ok((await f.after()).metadata.elements_delta);

  f.state.invalidateActionTargets({ session_id: 'a' });
  assert.equal((await f.after()).metadata.elements.length, 20, 'stale recapture or expiry: the full list');

  await f.after();
  f.state.invalidateWindowTargets([WINDOW], 'other-session');
  assert.equal(f.state.observationDeltaBySession.has('a'), false, 'another session mutated the window');
  await f.after();
  f.state.invalidateWorkerGeneration('a');
  assert.equal(f.state.observationDeltaBySession.has('a'), false);
  await f.after();
  f.state.releaseSessionState('a');
  assert.equal(f.state.observationDeltaBySession.has('a'), false);
});

test('the observation is the full list without a baseline, for a new window, a transition or a stalled generation', async () => {
  const f = fixture(treeRows(25));
  assert.equal((await f.after()).metadata.elements.length, 25, 'no baseline');
  assert.ok((await f.after()).metadata.elements_delta);

  // The model asked for the full list: an explicit capture is never a delta.
  const explicit = await f.run(() =>
    f.capture.captureComputer({
      action: 'capture',
      mode: 'ax',
      window_id: WINDOW,
      session_id: 'a',
      max_elements: DEFAULT_CAPTURE_MAX_ELEMENTS,
    })
  );
  assert.equal(explicit.payload.elements.length, 25);
  assert.equal(explicit.payload.elements_delta, undefined);
  assert.ok((await f.after()).metadata.elements_delta, 'an explicit capture is a baseline');

  const transition = await f.after({ fullObservation: true });
  assert.equal(transition.metadata.elements.length, 25, 'a window transition earns the whole list');
  assert.equal(f.state.observationDeltaBySession.get('a').consecutiveDeltas, 0);

  f.world.windowId = 'hwnd:0x2';
  assert.equal((await f.after()).metadata.elements.length, 25, 'another window');
  assert.ok((await f.after()).metadata.elements_delta);

  f.world.advance = 0; // the worker restarted: the generation did not advance
  assert.equal((await f.after()).metadata.elements.length, 25, 'generation lineage broken');
  f.world.advance = 2;
  assert.ok((await f.after()).metadata.elements_delta);
});

test('a different read of the window is never compared with the baseline', async () => {
  const f = fixture(treeRows(25));
  await f.after();
  const other = await f.run(() =>
    f.capture.captureAfterAction(
      {
        action: 'click',
        ref: 'held',
        window_id: WINDOW,
        session_id: 'a',
        capture_after_mode: 'ax',
        capture_after_max_elements: 20,
      },
      WINDOW,
      0,
      0
    )
  );
  assert.equal(other.metadata.elements.length, 20);
  assert.equal(other.metadata.elements_delta, undefined);
});

test('a delta that would be larger than the list falls back to the list', async () => {
  const f = fixture(treeRows(4));
  await f.after();
  f.world.rows = treeRows(4).map((row) => ({ ...row, name: `Renamed ${row.name}` }));
  const result = (await f.after()).metadata;
  assert.equal(result.elements.length, 4);
  assert.equal(result.elements_delta, undefined);
});

test('a long run of deltas returns to the full list so the rows it names stay in the model context', async () => {
  const f = fixture(treeRows(20));
  await f.after();
  for (let index = 0; index < 8; index += 1) assert.ok((await f.after()).metadata.elements_delta, `delta ${index + 1}`);
  assert.equal((await f.after()).metadata.elements.length, 20);
  assert.ok((await f.after()).metadata.elements_delta);
});

test('each delta addresses the refs the previous reply published, and rebuilds the full list', async () => {
  const f = fixture(treeRows(30));
  // The model's list: ref → what the row renders.
  const describe = (element) => `${element.role}|${element.name}|${element.bounds?.join(',')}`;
  const first = (await f.after()).metadata.elements;
  let model = new Map(first.map((element) => [element.ref, describe(element)]));
  const expected = () =>
    new Map(
      f.world.rows.map((row, index) => [
        `s${f.world.generation}:e${index}`,
        `${row.role}|${row.name}|10,${row.y ?? 20 * index},120,18`,
      ])
    );
  const apply = (delta) => {
    const next = new Map();
    for (const [held, live] of expandRuns(delta.unchanged)) {
      assert.ok(model.has(held), `${held} is a ref the previous reply published`);
      next.set(live, model.get(held));
    }
    for (const ref of delta.removed ?? []) assert.ok(model.has(ref), `${ref} removed from the list the model holds`);
    for (const row of delta.added ?? []) next.set(row.ref, describe(row));
    return next;
  };

  const rows = treeRows(30);
  const steps = [
    [...rows.slice(0, 12), ...rows.slice(14), { role: 'Button', name: 'Late', y: 900 }],
    [...rows.slice(0, 12), ...rows.slice(14, 25), { role: 'Button', name: 'Late', y: 900 }],
    [{ role: 'Button', name: 'First', y: 5 }, ...rows.slice(0, 12), ...rows.slice(14, 25)],
  ];
  const published = [];
  for (const world of steps) {
    f.world.rows = world;
    const delta = (await f.after()).metadata.elements_delta;
    assert.ok(delta, 'a delta, not the full list');
    published.push(new Set(model.keys()));
    model = apply(delta);
    assert.deepEqual(model, expected(), 'the rebuilt list is the full list');
  }
  // The second and third deltas name the refs of the reply before them, not the first list.
  assert.equal([...published[2]].every((ref) => ref.startsWith(`s${f.world.generation - 2}:`)), true);
});

test('OCR rows, failed reads and unsettled captures never form a baseline', () => {
  const store = new Map();
  const row = (ref, extra = {}) => ({ mark: 1, ref, role: 'Button', name: 'OK', ...extra });
  const input = {
    windowId: WINDOW,
    baselineKey: 'k',
    relatedWindowIds: [WINDOW],
    recordable: true,
    deltaAllowed: true,
  };
  assert.equal(recordObservation(store, 'a', { ...input, elements: [row('s1:e0')], generation: 1 }), undefined);
  assert.equal(store.has('a'), true);
  assert.equal(
    recordObservation(store, 'a', { ...input, elements: [row('ocr:1:2', { source: 'ocr' })], generation: 3 }),
    undefined
  );
  assert.equal(store.has('a'), false);
  recordObservation(store, 'a', { ...input, elements: [row('s5:e0')], generation: 5 });
  recordObservation(store, 'a', { ...input, elements: [row('s7:e0')], generation: 7, recordable: false });
  assert.equal(store.has('a'), false);
  recordObservation(store, 'a', { ...input, elements: [row('s5:e0')], generation: 5 });
  recordObservation(store, 'a', { ...input, elements: [row('s7:e0')], generation: null });
  assert.equal(store.has('a'), false);
  // A ref the model holds that is also live in the new snapshot would name another element.
  recordObservation(store, 'a', {
    ...input,
    elements: [row('s1:e0'), row('s1:e1', { name: 'Cancel' })],
    generation: 1,
  });
  const clash = recordObservation(store, 'a', {
    ...input,
    elements: [row('s1:e1', { name: 'Cancel' }), row('s1:e0')],
    generation: 2,
  });
  assert.equal(clash, undefined);
});

test('a dialog owned by the window forces the full list', async () => {
  const f = fixture(treeRows(20));
  await f.after();
  const store = f.state.observationDeltaBySession;
  const baseline = store.get('a');
  const withDialog = recordObservation(store, 'a', {
    elements: [{ mark: 1, ref: 's9:e0', role: 'Button', name: 'File 1' }],
    windowId: WINDOW,
    baselineKey: baseline.baselineKey,
    relatedWindowIds: [WINDOW, 'hwnd:0x9'],
    generation: baseline.generation + 2,
    recordable: true,
    deltaAllowed: true,
  });
  assert.equal(withDialog, undefined);
});

test('the payload sent after an action shrinks to the change', async (t) => {
  for (const count of [40, 75]) {
    const f = fixture(treeRows(count));
    const render = (metadata) =>
      canonicalComputerResultText(JSON.stringify({ action: 'act', ok: true, capture_after: metadata }), {
        action: 'act',
        input: {},
      });
    const full = render((await f.after()).metadata);
    // One toggled control and one dialog button: the usual result of an action.
    const rows = treeRows(count);
    f.world.rows = [{ ...rows[0], state: 'checked' }, ...rows.slice(1, count - 1), { role: 'Button', name: 'Done', y: 999 }];
    const delta = render((await f.after()).metadata);
    const unchanged = render((await f.after()).metadata);

    const parsed = JSON.parse(delta).observation;
    assert.equal(parsed.elements, undefined);
    assert.equal(parsed.changes, undefined, 'the count summary repeats the delta');
    assert.equal(parsed.elements_delta.added.length, 2);
    assert.match(parsed.elements_delta.added[0], /^\[s\d+:e0\] Button "File 1" state=checked /);
    assert.match(parsed.elements_delta.added[1], /^\[s\d+:e\d+\] Button "Done"/);
    const saving = 1 - delta.length / full.length;
    const unchangedSaving = 1 - unchanged.length / full.length;
    t.diagnostic(
      `${count} elements: full ${full.length} B (~${Math.round(full.length / 4)} tokens), delta ${delta.length} B ` +
        `(-${(saving * 100).toFixed(1)}%), unchanged ${unchanged.length} B (-${(unchangedSaving * 100).toFixed(1)}%)`
    );
    assert.ok(saving > 0.6, `${count} elements: delta saved ${saving}`);
    assert.ok(unchangedSaving > 0.7, `${count} elements: unchanged saved ${unchangedSaving}`);
  }
});
