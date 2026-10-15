// A deleted Lead never returns to the pool, whichever index instance of the
// process writes: the delete runs in the control runtime while the deleted
// session's own, still-loaded runtime settles its turn through another instance.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { fenceSessionWrites } from '../../../runtime/agent/orchestrator/session/store/live-state.mjs';
import { flushAllIndexWrites } from './index-write-queue.mjs';
import { createLeadWorkerIndex } from './lead-worker-index.mjs';

const cfgMod = { loadConfig: () => ({}) };
const workerRowFromSession = (session, tag, extra) => ({ sessionId: session.id, tag, ...extra });
const lead = (id) => ({ id, owner: 'user', agent: 'lead', closed: false, messages: [] });

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-lead-forget-'));
  const make = () => createLeadWorkerIndex({ dataDir: root, cfgMod, workerRowFromSession });
  const indexes = [];
  const open = () => {
    const index = make();
    indexes.push(index);
    return index;
  };
  const cleanup = async () => {
    for (const index of indexes) index.dispose();
    await flushAllIndexWrites();
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  };
  return { root, open, cleanup };
}

const rowsOf = (index, id) => index.readLeadWorkerRows().filter((row) => row.sessionId === id);

test('a late idle upsert from another index instance never re-adds a forgotten Lead', async () => {
  const { open, cleanup } = setup();
  try {
    const control = open();
    const owner = open(); // the deleted session's own runtime
    const session = lead('lead_forget_shared');
    owner.upsertLeadSession(session, { status: 'running' });
    await owner.flushLeadWorkerIndexWrites();
    assert.equal(rowsOf(control, session.id).length, 1);

    assert.equal(control.forgetLeadSession(session.id), true);
    await control.flushLeadWorkerIndexWrites();
    assert.equal(rowsOf(control, session.id).length, 0);

    assert.equal(owner.upsertLeadSession(session, { status: 'idle', stage: 'idle' }), false);
    await owner.flushLeadWorkerIndexWrites();
    await control.flushLeadWorkerIndexWrites();
    assert.equal(rowsOf(owner, session.id).length, 0, 'not in the owner view');
    assert.equal(rowsOf(control, session.id).length, 0, 'not on disk either');
  } finally {
    await cleanup();
  }
});

test('a row queued before the delete cannot overwrite it when it persists afterwards', async () => {
  const { open, cleanup } = setup();
  try {
    const control = open();
    const owner = open();
    const session = lead('lead_forget_queued');
    owner.upsertLeadSession(session, { status: 'running' });
    await owner.flushLeadWorkerIndexWrites();

    owner.upsertLeadSession(session, { status: 'idle', stage: 'idle' }); // queued, not persisted
    control.forgetLeadSession(session.id);
    await control.flushLeadWorkerIndexWrites();
    await owner.flushLeadWorkerIndexWrites();

    assert.equal(rowsOf(control, session.id).length, 0);
    assert.equal(rowsOf(owner, session.id).length, 0);
  } finally {
    await cleanup();
  }
});

test('a session id fenced by the store is refused even when no index forgot it', async () => {
  const { open, cleanup } = setup();
  try {
    const index = open();
    const session = lead('lead_forget_fenced');
    fenceSessionWrites(session.id);

    assert.equal(index.upsertLeadSession(session, { status: 'idle', stage: 'idle' }), false);
    await index.flushLeadWorkerIndexWrites();
    assert.equal(rowsOf(index, session.id).length, 0);

    const other = lead('lead_forget_unfenced');
    assert.equal(index.upsertLeadSession(other, { status: 'idle', stage: 'idle' }), true);
    assert.equal(rowsOf(index, other.id).length, 1, 'unrelated Leads are unaffected');
  } finally {
    await cleanup();
  }
});

test('forgetting in one data dir does not block the same id in another', async () => {
  const first = setup();
  const second = setup();
  try {
    const a = first.open();
    const b = second.open();
    a.forgetLeadSession('lead_forget_scoped');
    assert.equal(b.upsertLeadSession(lead('lead_forget_scoped'), { status: 'idle', stage: 'idle' }), true);
  } finally {
    await first.cleanup();
    await second.cleanup();
  }
});
