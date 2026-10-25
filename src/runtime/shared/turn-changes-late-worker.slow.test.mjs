// Which turn's change record a worker's edits join (fast lane, non-Git roots):
// the Lead turn running when the worker completes, else the next Lead turn to
// open or reopen — the turn that receives and reports the completion. A
// desktop completion wake is such a new turn with its own checkpoint.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

const gitAvailable = spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true }).status === 0;
const skip = gitAvailable ? false : 'git is unavailable';

const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'mixdog-late-worker-')));
process.env.MIXDOG_DATA_DIR = join(base, 'data');
process.on('exit', () => {
  rmSync(base, { recursive: true, force: true });
});

const snapshotModule = await import('./turn-snapshot.mjs');
const {
  _diffTrackerForTest,
  _parkedWorkerReviewsForTest,
  _resetTurnSnapshotForTest,
  beginAgentTurnReview,
  beginTurnSnapshot,
  clearSessionChangeHistory,
  completeAgentTurnReview,
  completeTurnSnapshot,
  getTurnChanges,
  reapplyTurnChanges,
  recordTurnDiffChanges,
  revertTurnChanges,
} = snapshotModule;
const { createSnapshotTrackerFactory } = await import('../../session-runtime/turn/turn-run/snapshot-tracker.mjs');
const { createTurnReviewCollector } = await import('../../session-runtime/services/agent-tool/turn-review.mjs');
const { loadTurnChangeRecord } = await import('./turn-snapshot-store.mjs');
const agentsOf = async (sessionId, checkpointId) =>
  ((await loadTurnChangeRecord(sessionId, checkpointId))?.agents || []).map((agent) => agent.sessionId);

const MOCKUP = 'design/mockups/x/index.html';
let seq = 0;

function newRoot(seed = {}) {
  const root = join(base, `root-${++seq}`);
  mkdirSync(root, { recursive: true });
  for (const [path, content] of Object.entries(seed)) writeFile(root, path, content);
  return root;
}

function writeFile(root, path, content) {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

const read = (root, path) => (existsSync(join(root, path)) ? readFileSync(join(root, path), 'utf8') : null);

/** One own-tool write of `path` by `sessionId` (a Lead or a worker). */
function edit(sessionId, root, path, after) {
  const before = read(root, path);
  writeFile(root, path, after);
  recordTurnDiffChanges(sessionId, [{ path: join(root, path), displayPath: path, before, after }]);
}

/** The record once no seal of it is in flight. */
async function settled(sessionId, checkpointId) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const reply = await getTurnChanges(sessionId, { checkpointId });
    if (reply.status !== 'pending') return reply;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`${checkpointId} stayed pending`);
}

const filesOf = async (sessionId, checkpointId) =>
  (await settled(sessionId, checkpointId)).files.map((file) => [file.path, file.status, file.state]);

/** A Lead turn that launched `workers`, then ended. */
async function launchingTurn(lead, root, workers, checkpointId = 'cp-1') {
  const token = await beginTurnSnapshot(root, lead, { checkpointId });
  const handles = workers.map((name) => beginAgentTurnReview(lead, `${lead}-${name}`, { agent: 'worker' }));
  await completeTurnSnapshot(lead, token);
  return handles;
}

/** A whole Lead turn: open, `body`, seal. */
async function leadTurn(lead, root, checkpointId, body = () => {}, options = {}) {
  const token = await beginTurnSnapshot(root, lead, { checkpointId, ...options });
  await body();
  await completeTurnSnapshot(lead, token);
}

test('a: a worker finishing after its turn sealed lands in the desktop wake turn that reports it', {
  skip,
}, async () => {
  _resetTurnSnapshotForTest();
  const lead = 'late-a';
  const root = newRoot();
  const [worker] = await launchingTurn(lead, root, ['w']);
  edit(`${lead}-w`, root, MOCKUP, '<html>x</html>\n');
  assert.equal(completeAgentTurnReview(worker), true);
  // The desktop drains the completion as a new turn keyed by its own entry.
  await leadTurn(lead, root, 'wake-1');
  assert.deepEqual(await filesOf(lead, 'wake-1'), [[MOCKUP, 'A', 'applied']]);
  assert.deepEqual(await filesOf(lead, 'cp-1'), [], 'the sealed launching record is never rewritten');
  assert.deepEqual(await agentsOf(lead, 'wake-1'), [`${lead}-w`]);
});

test('a: a runtime completion wake that reopens the launching turn records the worker there', { skip }, async () => {
  _resetTurnSnapshotForTest();
  const lead = 'late-a-reopen';
  const root = newRoot();
  const [worker] = await launchingTurn(lead, root, ['w']);
  edit(`${lead}-w`, root, MOCKUP, '<html>x</html>\n');
  assert.equal(completeAgentTurnReview(worker), true);
  await leadTurn(lead, root, '', () => {}, { continueTurn: true });
  assert.deepEqual(await filesOf(lead, 'cp-1'), [[MOCKUP, 'A', 'applied']]);
});

test('b/1: a T1 worker completing while T2 runs lands in T2 once, its pre-T2 edits included', { skip }, async () => {
  _resetTurnSnapshotForTest();
  const lead = 'late-running';
  const root = newRoot();
  const [worker] = await launchingTurn(lead, root, ['w']);
  edit(`${lead}-w`, root, MOCKUP, '<html>1</html>\n');
  await leadTurn(lead, root, 'cp-2', () => {
    edit(`${lead}-w`, root, 'design/mockups/x/style.css', 'a{}\n');
    edit(lead, root, 'lead.txt', 'lead\n');
    assert.equal(completeAgentTurnReview(worker), true);
  });
  assert.deepEqual(await filesOf(lead, 'cp-2'), [
    ['design/mockups/x/index.html', 'A', 'applied'],
    ['design/mockups/x/style.css', 'A', 'applied'],
    ['lead.txt', 'A', 'applied'],
  ]);
  assert.deepEqual(await filesOf(lead, 'cp-1'), []);
  // The next turn starts clean: nothing is attributed twice.
  await leadTurn(lead, root, 'cp-3');
  assert.deepEqual(await filesOf(lead, 'cp-3'), []);
});

test('b/1: a T1 worker completing after T2 sealed lands in the wake turn only', { skip }, async () => {
  _resetTurnSnapshotForTest();
  const lead = 'late-sealed';
  const root = newRoot();
  const [worker] = await launchingTurn(lead, root, ['w']);
  edit(`${lead}-w`, root, MOCKUP, '<html>1</html>\n');
  await leadTurn(lead, root, 'cp-2', () => edit(lead, root, 'lead.txt', 'lead\n'));
  edit(`${lead}-w`, root, MOCKUP, '<html>2</html>\n');
  assert.equal(completeAgentTurnReview(worker), true);
  await leadTurn(lead, root, 'wake-1');
  assert.deepEqual(await filesOf(lead, 'wake-1'), [[MOCKUP, 'A', 'applied']]);
  assert.deepEqual(await filesOf(lead, 'cp-2'), [['lead.txt', 'A', 'applied']]);
  assert.deepEqual(await filesOf(lead, 'cp-1'), []);
  const patch = (await getTurnChanges(lead, { checkpointId: 'wake-1', patch: true, file: MOCKUP })).patch;
  assert.match(patch, /\+<html>2<\/html>/);
});

test('2: two T1 workers, one done before T2 opens and one during T2, both land in T2 once', { skip }, async () => {
  _resetTurnSnapshotForTest();
  const lead = 'late-two';
  const root = newRoot();
  const [first, second] = await launchingTurn(lead, root, ['w1', 'w2']);
  edit(`${lead}-w1`, root, 'one.html', '<p>1</p>\n');
  edit(`${lead}-w2`, root, 'two.html', '<p>2</p>\n');
  assert.equal(completeAgentTurnReview(first), true);
  await leadTurn(lead, root, 'cp-2', () => {
    assert.equal(completeAgentTurnReview(second), true);
  });
  assert.deepEqual(await filesOf(lead, 'cp-2'), [
    ['one.html', 'A', 'applied'],
    ['two.html', 'A', 'applied'],
  ]);
  assert.deepEqual(await agentsOf(lead, 'cp-2'), [`${lead}-w1`, `${lead}-w2`]);
  assert.deepEqual(await filesOf(lead, 'cp-1'), []);
  await leadTurn(lead, root, 'cp-3');
  assert.deepEqual(await filesOf(lead, 'cp-3'), []);
});

const SEED = '1\n2\n3\n4\n5\n';
const FINAL = 'W\n2\n3\n4\nL\n';

for (const order of ['worker-first', 'lead-first']) {
  test(`3 (${order}): a T1 worker and the T2 Lead editing one file merge in write order; Undo/Reapply`, {
    skip,
  }, async () => {
    _resetTurnSnapshotForTest();
    const lead = `late-same-${order}`;
    const root = newRoot({ 'f.txt': SEED });
    const [worker] = await launchingTurn(lead, root, ['w']);
    const workerEdit = () => edit(`${lead}-w`, root, 'f.txt', read(root, 'f.txt').replace(/^1\n/, 'W\n'));
    const leadEdit = () => edit(lead, root, 'f.txt', read(root, 'f.txt').replace(/5\n$/, 'L\n'));
    if (order === 'worker-first') workerEdit();
    await leadTurn(lead, root, 'cp-2', () => {
      if (order === 'worker-first') leadEdit();
      else {
        leadEdit();
        workerEdit();
      }
      assert.equal(completeAgentTurnReview(worker), true);
    });
    assert.equal(read(root, 'f.txt'), FINAL);
    let reply = await settled(lead, 'cp-2');
    assert.deepEqual(
      reply.files.map((file) => [file.path, file.status, file.state, file.additions, file.deletions]),
      [['f.txt', 'M', 'applied', 2, 2]]
    );

    // A foreign edit inside the record's hunk: the Undo fails, nothing is overwritten.
    writeFile(root, 'f.txt', FINAL.replace(/^W\n/, 'X\n'));
    await assert.rejects(revertTurnChanges(lead, 'cp-2', null, reply.revision));
    assert.equal(read(root, 'f.txt'), FINAL.replace(/^W\n/, 'X\n'));
    writeFile(root, 'f.txt', FINAL);

    reply = await revertTurnChanges(lead, 'cp-2', null, reply.revision);
    assert.equal(read(root, 'f.txt'), SEED, 'the Undo restores the bytes from before both writes');
    assert.deepEqual(
      reply.files.map((file) => file.state),
      ['reverted']
    );
    reply = await reapplyTurnChanges(lead, 'cp-2', null, reply.revision);
    assert.equal(read(root, 'f.txt'), FINAL);
    assert.deepEqual(await filesOf(lead, 'cp-1'), []);
  });
}

test('4: a cancelled launching turn’s worker lands in the turn that reports it', { skip }, async () => {
  _resetTurnSnapshotForTest();
  const lead = 'late-cancelled';
  const root = newRoot();
  const sealed = [];
  const createSnapshot = createSnapshotTrackerFactory({
    getCurrentCwd: () => root,
    beginTurnSnapshotForTurn: beginTurnSnapshot,
    completeTurnSnapshotForTurn: (...args) => {
      const run = completeTurnSnapshot(...args);
      sealed.push(run);
      return run;
    },
    turnCleanupSettleMs: 1_000,
  });
  const turn = createSnapshot({ id: 'cp-1' });
  turn.start(lead);
  await turn.promise;
  const worker = beginAgentTurnReview(lead, `${lead}-w`, { agent: 'worker' });
  const controller = new AbortController();
  controller.abort();
  await turn.finish(controller.signal, (run) => run());
  // The abort seals on its own schedule; wait for it to land.
  await new Promise((resolve) => setImmediate(resolve));
  await Promise.all(sealed);
  edit(`${lead}-w`, root, MOCKUP, '<html>x</html>\n');
  assert.equal(completeAgentTurnReview(worker), true);
  await leadTurn(lead, root, 'wake-1');
  assert.deepEqual(await filesOf(lead, 'wake-1'), [[MOCKUP, 'A', 'applied']]);
  assert.deepEqual(await filesOf(lead, 'cp-1'), []);
});

test('5: a worker resumed after a runtime restart (no Lead turn in memory) joins the Lead’s next turn', {
  skip,
}, async () => {
  _resetTurnSnapshotForTest();
  const lead = 'late-restart';
  const root = newRoot();
  await launchingTurn(lead, root, ['w']);
  // Restart: every in-memory turn, tracker and handle is gone.
  _resetTurnSnapshotForTest();
  const resumed = beginAgentTurnReview(lead, `${lead}-w`, { agent: 'worker' });
  assert.ok(resumed, 'the resumed worker still binds to its Lead');
  edit(`${lead}-w`, root, MOCKUP, '<html>x</html>\n');
  assert.equal(completeAgentTurnReview(resumed), true);
  await leadTurn(lead, root, 'wake-1');
  assert.deepEqual(await filesOf(lead, 'wake-1'), [[MOCKUP, 'A', 'applied']]);
});

test('parked reviews of Leads that never open another turn stay bounded, oldest dropped first', {
  skip,
}, async () => {
  _resetTurnSnapshotForTest();
  const root = newRoot();
  const leads = Array.from({ length: 34 }, (_, index) => `late-bounded-${index}`);
  // Restart path: no Lead has a turn in memory, so every completion parks.
  for (const lead of leads) {
    const worker = beginAgentTurnReview(lead, `${lead}-w`, { agent: 'worker' });
    edit(`${lead}-w`, root, `out/${lead}.html`, '<html>x</html>\n');
    assert.equal(completeAgentTurnReview(worker), true);
  }
  await leadTurn(leads[0], root, 'wake-oldest');
  assert.deepEqual(await filesOf(leads[0], 'wake-oldest'), [], 'the oldest parked review was released');
  await leadTurn(leads.at(-1), root, 'wake-newest');
  assert.deepEqual(await filesOf(leads.at(-1), 'wake-newest'), [[`out/${leads.at(-1)}.html`, 'A', 'applied']]);
});

test('a worker bound before its Lead’s change history was deleted never writes into the new history', {
  skip,
}, async () => {
  _resetTurnSnapshotForTest();
  const lead = 'late-cleared';
  const root = newRoot();
  const [worker] = await launchingTurn(lead, root, ['w']);
  edit(`${lead}-w`, root, MOCKUP, '<html>x</html>\n');
  await clearSessionChangeHistory(lead);
  assert.equal(completeAgentTurnReview(worker, ['diff --git a/x b/x\n']), false);
  await leadTurn(lead, root, 'cp-2');
  assert.deepEqual(await filesOf(lead, 'cp-2'), []);
});

const patchBytes = (reviews) => reviews.reduce((total, review) => total + Buffer.byteLength(review.patch, 'utf8'), 0);

/** `runs` executions of one worker, each writing its own file, all completing
 *  after the Lead's turn ended. */
async function parkRuns(lead, root, runs) {
  const key = `${lead}-w`;
  await launchingTurn(lead, root, []);
  const trackers = [];
  for (let run = 0; run < runs; run += 1) {
    const handle = beginAgentTurnReview(lead, key, { agent: 'worker' });
    trackers.push(_diffTrackerForTest(key));
    edit(key, root, `run-${run}.html`, `<p>${run}</p>\n`);
    assert.equal(completeAgentTurnReview(handle), true);
  }
  return { key, trackers };
}

test('1: repeated completions of one worker park one merged review that keeps every run’s edits', {
  skip,
}, async () => {
  _resetTurnSnapshotForTest();
  const lead = 'park-repeat';
  const root = newRoot();
  const { key, trackers } = await parkRuns(lead, root, 5);
  const parked = _parkedWorkerReviewsForTest(lead);
  assert.deepEqual(
    parked.map((review) => review.key),
    [key]
  );
  for (let run = 0; run < 5; run += 1) assert.match(parked[0].patch, new RegExp(`run-${run}\\.html`));
  assert.equal(_diffTrackerForTest(key), undefined);
  await leadTurn(lead, root, 'wake-1');
  assert.deepEqual(
    await filesOf(lead, 'wake-1'),
    Array.from({ length: 5 }, (_, run) => [`run-${run}.html`, 'A', 'applied'])
  );
  assert.deepEqual(await agentsOf(lead, 'wake-1'), [key]);
  assert.deepEqual(_parkedWorkerReviewsForTest(lead), []);
  for (const tracker of trackers) assert.equal(tracker.chains.size, 0, 'adoption released every run’s content');
});

test('1: a worker parked twice lands both runs’ files once in the adopting turn, and its Undo reverts both', {
  skip,
}, async () => {
  _resetTurnSnapshotForTest();
  const lead = 'park-twice';
  const root = newRoot();
  await parkRuns(lead, root, 2);
  await leadTurn(lead, root, 'wake-1');
  let reply = await settled(lead, 'wake-1');
  assert.deepEqual(
    reply.files.map((file) => [file.path, file.status, file.state, file.additions, file.deletions]),
    [
      ['run-0.html', 'A', 'applied', 1, 0],
      ['run-1.html', 'A', 'applied', 1, 0],
    ]
  );
  reply = await revertTurnChanges(lead, 'wake-1', null, reply.revision);
  assert.deepEqual(
    reply.files.map((file) => file.state),
    ['reverted', 'reverted']
  );
  assert.equal(read(root, 'run-0.html'), null);
  assert.equal(read(root, 'run-1.html'), null);
});

test('1: an inactive Lead’s parked reviews keep the turn’s worker-review count and byte limits, oldest out first', {
  skip,
}, async () => {
  _resetTurnSnapshotForTest();
  const root = newRoot();
  const park = async (lead, count, contentOf) => {
    await launchingTurn(lead, root, []);
    const trackers = [];
    for (let index = 0; index < count; index += 1) {
      const key = `${lead}-w${index}`;
      const handle = beginAgentTurnReview(lead, key, { agent: 'worker' });
      trackers.push(_diffTrackerForTest(key));
      edit(key, root, `${lead}/${index}.txt`, contentOf(index));
      assert.equal(completeAgentTurnReview(handle), true);
    }
    const parked = _parkedWorkerReviewsForTest(lead);
    const kept = new Set(parked.map((review) => review.key));
    trackers.forEach((tracker, index) => {
      if (!kept.has(`${lead}-w${index}`))
        assert.equal(tracker.chains.size, 0, 'an evicted review released its content');
    });
    return parked;
  };

  const byCount = await park('park-count', 40, (index) => `${index}\n`);
  assert.deepEqual(
    byCount.map((review) => review.key),
    Array.from({ length: 32 }, (_, index) => `park-count-w${index + 8}`)
  );

  // 20 small reviews, then 20 of ~300 KB: the byte limit evicts oldest first.
  const big = `${'x'.repeat(99)}\n`.repeat(3_000);
  const byBytes = await park('park-bytes', 40, (index) => (index < 20 ? `${index}\n` : `${index}\n${big}`));
  assert.ok(patchBytes(byBytes) <= 4 * 1024 * 1024, `${patchBytes(byBytes)} parked patch bytes`);
  assert.ok(byBytes.length < 20, 'the byte limit, not the count, bounded them');
  assert.equal(byBytes.at(-1).key, 'park-bytes-w39');
  await leadTurn('park-bytes', root, 'wake-1');
  assert.equal(
    (await agentsOf('park-bytes', 'wake-1')).length,
    byBytes.length,
    'the adopting turn reports exactly the retained reviews'
  );
});

/** A Lead turn launched `done` (completed, parked) and `running` (still
 *  running, edits made): the in-memory state a cleanup must release. */
async function parkedAndRunning(lead, root) {
  const [done, running] = await launchingTurn(lead, root, ['done', 'running']);
  const doneTracker = _diffTrackerForTest(`${lead}-done`);
  const runningTracker = _diffTrackerForTest(`${lead}-running`);
  edit(`${lead}-done`, root, `${lead}/done.html`, '<p>done</p>\n');
  edit(`${lead}-running`, root, `${lead}/running.html`, '<p>running</p>\n');
  assert.equal(completeAgentTurnReview(done), true);
  assert.deepEqual(
    _parkedWorkerReviewsForTest(lead).map((review) => review.key),
    [`${lead}-done`]
  );
  return { running, doneTracker, runningTracker };
}

function assertReleased(lead, { running, doneTracker, runningTracker }) {
  assert.deepEqual(_parkedWorkerReviewsForTest(lead), []);
  assert.equal(_diffTrackerForTest(`${lead}-running`), undefined);
  assert.equal(doneTracker.chains.size, 0, 'the parked review’s content was released');
  assert.equal(runningTracker.chains.size, 0, 'the bound worker tracker’s content was released');
  assert.equal(completeAgentTurnReview(running), false, 'the running worker’s later completion parks nothing');
  assert.deepEqual(_parkedWorkerReviewsForTest(lead), []);
}

test('2a: deleting the Lead’s change history releases its parked reviews and bound worker trackers', {
  skip,
}, async () => {
  _resetTurnSnapshotForTest();
  const lead = 'cleanup-history';
  const root = newRoot();
  const state = await parkedAndRunning(lead, root);
  await clearSessionChangeHistory(lead);
  assertReleased(lead, state);
  await leadTurn(lead, root, 'cp-2');
  assert.deepEqual(await filesOf(lead, 'cp-2'), []);
});

test('2a: deleting the Lead session releases its turn, parked reviews and bound worker trackers', {
  skip,
}, async () => {
  _resetTurnSnapshotForTest();
  const lead = 'cleanup-session';
  const root = newRoot();
  const state = await parkedAndRunning(lead, root);
  snapshotModule.forgetTurnSnapshotSession(lead);
  assert.equal(_diffTrackerForTest(lead), undefined);
  assertReleased(lead, state);
});

for (const outcome of ['failed', 'cancelled']) {
  /** One worker execution through the real collector: send-flow calls its
   *  complete() in a finally, for every outcome. */
  const runWorker = async (lead, body) => {
    const collector = createTurnReviewCollector({ id: `${lead}-w` }, 'w', 'worker', { callerSessionId: lead });
    try {
      await body(collector);
      throw outcome === 'failed' ? new Error('worker failed') : new DOMException('aborted', 'AbortError');
    } finally {
      collector.complete();
    }
  };

  test(`2b (${outcome}): a worker that ends with no edits parks nothing and leaves no bound tracker`, {
    skip,
  }, async () => {
    _resetTurnSnapshotForTest();
    const lead = `ended-empty-${outcome}`;
    const root = newRoot();
    await launchingTurn(lead, root, []);
    await assert.rejects(runWorker(lead, () => {}));
    assert.deepEqual(_parkedWorkerReviewsForTest(lead), []);
    assert.equal(_diffTrackerForTest(`${lead}-w`), undefined);
    await leadTurn(lead, root, 'wake-1');
    assert.deepEqual(await filesOf(lead, 'wake-1'), []);
    assert.deepEqual(await agentsOf(lead, 'wake-1'), []);
  });

  test(`2b (${outcome}): a worker’s partial edits stay attributed like a completed worker’s, its tracker released`, {
    skip,
  }, async () => {
    _resetTurnSnapshotForTest();
    const lead = `ended-partial-${outcome}`;
    const root = newRoot();
    await launchingTurn(lead, root, []);
    let tracker = null;
    await assert.rejects(
      runWorker(lead, () => {
        tracker = _diffTrackerForTest(`${lead}-w`);
        edit(`${lead}-w`, root, MOCKUP, '<html>partial</html>\n');
      })
    );
    assert.deepEqual(
      _parkedWorkerReviewsForTest(lead).map((review) => review.key),
      [`${lead}-w`]
    );
    assert.equal(_diffTrackerForTest(`${lead}-w`), undefined);
    await leadTurn(lead, root, 'wake-1');
    assert.deepEqual(await filesOf(lead, 'wake-1'), [[MOCKUP, 'A', 'applied']]);
    assert.equal(tracker.chains.size, 0);
  });
}

test('2c: a cache trim of the Lead releases its parked reviews and bound worker trackers', { skip }, async () => {
  _resetTurnSnapshotForTest();
  const lead = 'cleanup-trim';
  const root = newRoot();
  const state = await parkedAndRunning(lead, root);
  for (let index = 0; index < 32; index += 1) await leadTurn(`cleanup-trim-other-${index}`, newRoot(), 'cp');
  assertReleased(lead, state);
});
