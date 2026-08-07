// Late-delivery gate: genuine user/steering entries older than the
// replay window (30m) still DELIVER on hydrate/foreign-drain — annotated with
// an explicit "[late delivery: ...]" header — instead of being silently
// dropped. TUI steering restore keeps the drop: a dead surface's local queue
// follows process-lifetime queue semantics.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Redirect the spool to a throwaway dir before import so the real
// ~/.mixdog/data spool is never touched.
const dataDir = mkdtempSync(join(tmpdir(), 'mixstale-'));
process.env.MIXDOG_DATA_DIR = dataDir;

const {
  hydratePendingMessages,
  drainPendingMessages,
  drainForeignUserInjections,
  acknowledgePendingMessages,
} = await import('../src/runtime/agent/orchestrator/session/manager/pending-messages.mjs');
const { appendTuiSteeringPersist, drainTuiSteeringPersist, flushTuiSteeringPersist } =
  await import('../src/tui/session/tui-steering-persist.mjs');
const { createSessionFlow } = await import('../src/tui/session/session-flow.mjs');

const spoolPath = join(dataDir, 'session-pending-messages.json');
const HOUR = 60 * 60 * 1000;
const texts = (entries) => entries.map((m) => (typeof m === 'string' ? m : m.text));

function writeSpool(mutate) {
  let store = { version: 1, updatedAt: Date.now(), sessions: {}, sessionTouchedAt: {} };
  try { store = JSON.parse(readFileSync(spoolPath, 'utf8')); } catch { /* fresh */ }
  mutate(store);
  writeFileSync(spoolPath, JSON.stringify(store));
}

test('hydrate late-delivers stale user entries and keeps fresh ones', async () => {
  const sid = 'sess_stale_hydrate';
  const now = Date.now();
  writeSpool((store) => {
    store.sessions[sid] = [
      { id: 'stale_a', message: 'queued two hours ago', enqueuedAt: now - 2 * HOUR },
      { id: 'fresh_a', message: 'queued just now', enqueuedAt: now - 1000 },
    ];
    store.sessionTouchedAt[sid] = now - 1000;
  });

  assert.equal(await hydratePendingMessages(sid), 2, 'both entries hydrate');
  const delivered = drainPendingMessages(sid);
  const deliveredTexts = texts(delivered);
  assert.equal(deliveredTexts.length, 2);
  assert.match(deliveredTexts[0], /^\[late delivery: queued ~2h ago/);
  assert.ok(deliveredTexts[0].endsWith('queued two hours ago'), 'original text preserved under the header');
  assert.equal(deliveredTexts[1], 'queued just now');
  acknowledgePendingMessages(sid, delivered);
  await new Promise((r) => setTimeout(r, 30));
  const store = JSON.parse(readFileSync(spoolPath, 'utf8'));
  assert.equal(store.sessions[sid], undefined, 'delivered entries acked out of the spool');
});

test('foreign drain injects fresh submits and late-delivers stale ones', async () => {
  const sid = 'sess_stale_foreign';
  const now = Date.now();
  writeSpool((store) => {
    store.sessions[sid] = [
      { id: 'foreign_stale', message: 'stale cross-surface submit', enqueuedAt: now - 3 * HOUR },
      { id: 'foreign_fresh', message: 'fresh cross-surface submit', enqueuedAt: now - 5000 },
    ];
    store.sessionTouchedAt[sid] = now - 5000;
  });

  const taken = await drainForeignUserInjections(sid);
  assert.equal(taken.length, 2);
  assert.match(taken[0].text, /^\[late delivery: queued ~3h ago/);
  assert.ok(taken[0].text.endsWith('stale cross-surface submit'), 'original text preserved under the header');
  assert.equal(taken[0].id, 'foreign_stale');
  assert.equal(taken[1].text, 'fresh cross-surface submit');
  assert.equal(taken[1].id, 'foreign_fresh');
  const store = JSON.parse(readFileSync(spoolPath, 'utf8'));
  assert.equal(store.sessions[sid], undefined, 'both submits removed alongside the drain');
});

test('foreign drain preserves structured attachment references and restore metadata', async () => {
  const sid = 'sess_structured_foreign';
  const now = Date.now();
  const ref = 'b'.repeat(64);
  writeSpool((store) => {
    store.sessions[sid] = [{
      id: 'foreign_structured',
      content: [
        { type: 'text', text: 'inspect' },
        { type: 'image', attachmentRef: ref, sizeBytes: 3, mimeType: 'image/png' },
      ],
      text: 'inspect [Image]',
      options: {
        pastedImages: {
          1: { id: 1, type: 'image', attachmentRef: ref, sizeBytes: 3, mediaType: 'image/png' },
        },
      },
      enqueuedAt: now,
    }];
    store.sessionTouchedAt[sid] = now;
  });
  const [taken] = await drainForeignUserInjections(sid);
  assert.equal(taken.id, 'foreign_structured');
  assert.equal(taken.content[1].attachmentRef, ref);
  assert.equal(taken.options.pastedImages[1].attachmentRef, ref);
});

test('legacy string entries age from sessionTouchedAt and still late-deliver', async () => {
  const sid = 'sess_stale_legacy';
  const now = Date.now();
  writeSpool((store) => {
    // Legacy plain-string queue (pre-id era) whose session was last touched
    // days ago; the store-wide updatedAt is fresh (any unrelated write).
    store.sessions[sid] = ['days-old legacy message'];
    store.sessionTouchedAt[sid] = now - 3 * 24 * HOUR;
    store.updatedAt = now;
  });

  assert.equal(await hydratePendingMessages(sid), 1, 'stale legacy string hydrates for late delivery');
  const delivered = drainPendingMessages(sid);
  assert.equal(delivered.length, 1);
  assert.match(texts(delivered)[0], /^\[late delivery: queued ~72h ago/);
  assert.ok(texts(delivered)[0].endsWith('days-old legacy message'), 'original text preserved under the header');
  assert.deepEqual(await drainForeignUserInjections(sid), [], 'hydrated entry never double-injects via the foreign drain');
});

test('TUI steering restore drops stale rows and keeps fresh ones', async () => {
  const lead = 'sess_stale_steering';
  await appendTuiSteeringPersist(lead, { text: 'fresh steering row' });
  await flushTuiSteeringPersist();
  writeSpool((store) => {
    // Simulate a stale leftover row from a long-dead TUI (old per-row stamp).
    store.sessions[`tui_${lead}`].unshift({ id: 'ts_old', text: 'stale steering row', at: Date.now() - 2 * HOUR });
  });

  const drained = await drainTuiSteeringPersist(lead);
  assert.deepEqual(drained.map((row) => row.text), ['fresh steering row']);
  const store = JSON.parse(readFileSync(spoolPath, 'utf8'));
  assert.equal(store.sessions[`tui_${lead}`], undefined, 'steering key fully consumed');
});

test('TUI steering rows without stamps age from the key touch time', async () => {
  const lead = 'sess_stale_steering_legacy';
  writeSpool((store) => {
    store.sessions[`tui_${lead}`] = [{ id: 'ts_legacy', text: 'legacy stampless row' }];
    store.sessionTouchedAt[`tui_${lead}`] = Date.now() - 2 * HOUR;
  });
  const drained = await drainTuiSteeringPersist(lead);
  assert.deepEqual(drained, [], 'stampless stale row dropped by key age');
});

test('idle reconnect restores a fresh steering row without auto-submitting it', async () => {
  const lead = 'sess_visible_reconnect';
  await appendTuiSteeringPersist(lead, { text: 'wait for the next real boundary' });
  await flushTuiSteeringPersist();
  let state = { queued: [], busy: false, commandBusy: false };
  let runTurns = 0;
  const bag = {
    runtime: { id: lead },
    nextId: (() => {
      let sequence = 0;
      return () => `restore_${++sequence}`;
    })(),
    tuiDebug: () => {},
    flags: {},
    pending: [],
    pendingNotificationKeys: new Set(),
    displayedExecutionNotificationKeys: new Set(),
    getState: () => state,
    set: (patch) => { state = { ...state, ...patch }; },
    pushItem: () => {},
    replaceItems: (items) => items,
    pushNotice: () => {},
    pushUserOrSyntheticItem: () => {},
    autoClearState: () => ({ enabled: false }),
    agentStatusState: () => ({}),
    routeState: () => ({}),
    syncContextStats: () => {},
    flushDeferredExecutionPendingResumeKick: () => {},
    runTurn: async () => {
      runTurns += 1;
      return 'done';
    },
  };
  const flow = createSessionFlow(bag);

  await flow.restoreLeadSteeringFromDisk();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(runTurns, 0, 'reconnect alone must not create a user turn');
  assert.deepEqual(state.queued.map((entry) => entry.text), ['wait for the next real boundary']);
  assert.equal(bag.pending.length, 1, 'the recovered row remains in the normal editable queue');

  await flow.drain();
  assert.equal(runTurns, 1, 'the normal turn-boundary drain still consumes the recovered row');
  assert.equal(bag.pending.length, 0);
});

test.after(() => {
  try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
});
