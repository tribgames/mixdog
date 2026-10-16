// The `.own` presence sidecar never outlives its session record: no beacon
// for a missing record, a publish racing a deletion removes what it wrote,
// deletion removes it, and the sweep reaps leftovers whose record is gone.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'mixdog-presence-'));
process.env.MIXDOG_DATA_DIR = root;

const { publishSessionPresence, deleteSessionPresence, settleSessionPresence, sessionPath } = await import(
  './paths-heartbeat.mjs'
);
const { saveSessionAsync, deleteSession } = await import('../store.mjs');
const { reapOrphanSidecars } = await import('./sweep/sweep-finish.mjs');
const { settleSessionSummaryIndex } = await import('./listing.mjs');

const sessionsDir = join(root, 'sessions');
const ownPath = (id) => join(sessionsDir, `${id}.own`);

test.after(async () => {
  await settleSessionSummaryIndex();
  rmSync(root, { recursive: true, force: true });
});

const record = (id) => ({
  id,
  owner: 'user',
  status: 'idle',
  createdAt: Date.now(),
  updatedAt: Date.now(),
  messages: [{ role: 'user', content: 'hi' }],
});

test('no presence beacon is written for a session without a record', async () => {
  const id = 'sess_presence_no_record';
  publishSessionPresence(id);
  await settleSessionPresence(id);
  assert.equal(existsSync(ownPath(id)), false);
  // The throttle stayed open: once the record lands, the next tick publishes.
  mkdirSync(sessionsDir, { recursive: true });
  writeFileSync(sessionPath(id), JSON.stringify(record(id)));
  publishSessionPresence(id);
  await settleSessionPresence(id);
  assert.equal(existsSync(ownPath(id)), true);
  deleteSessionPresence(id);
  assert.equal(existsSync(ownPath(id)), false);
});

test('a publish in flight when the session is deleted does not leave its sidecar behind', async () => {
  const id = 'sess_presence_delete_race';
  await saveSessionAsync(record(id));
  publishSessionPresence(id);
  // Delete before the async beacon write has landed.
  assert.equal(deleteSession(id), true);
  await settleSessionPresence(id);
  assert.equal(existsSync(ownPath(id)), false);
  // A live surface still ticking for the deleted session never recreates it.
  publishSessionPresence(id);
  await settleSessionPresence(id);
  assert.equal(existsSync(ownPath(id)), false);
});

test('deleting a session removes its presence sidecar', async () => {
  const id = 'sess_presence_delete';
  await saveSessionAsync(record(id));
  publishSessionPresence(id);
  await settleSessionPresence(id);
  assert.equal(existsSync(ownPath(id)), true);
  assert.equal(deleteSession(id), true);
  assert.equal(existsSync(ownPath(id)), false);
});

test('the sweep reaps only presence sidecars whose session record is gone', () => {
  mkdirSync(sessionsDir, { recursive: true });
  const now = Date.now();
  const stale = new Date(now - 10 * 60 * 1000);
  // Orphan, untouched past the presence window.
  writeFileSync(ownPath('sess_orphan_stale'), `${now}\n${process.pid}\n`);
  utimesSync(ownPath('sess_orphan_stale'), stale, stale);
  // Orphan whose recorded owner process no longer exists.
  writeFileSync(ownPath('sess_orphan_dead_owner'), `${now}\n2147483646\n`);
  // Fresh orphan of a live owner: left for its owner (or the window) to settle.
  writeFileSync(ownPath('sess_orphan_fresh_live'), `${now}\n${process.pid}\n`);
  // A stale sidecar with its record present belongs to a real session.
  writeFileSync(sessionPath('sess_with_record'), JSON.stringify(record('sess_with_record')));
  writeFileSync(ownPath('sess_with_record'), `${now}\n2147483646\n`);
  utimesSync(ownPath('sess_with_record'), stale, stale);

  const tally = { cleaned: 0 };
  for (const _ of reapOrphanSidecars({ plan: { maxAge: 24 * 60 * 60 * 1000 }, dir: sessionsDir, now, tally }));
  assert.equal(existsSync(ownPath('sess_orphan_stale')), false);
  assert.equal(existsSync(ownPath('sess_orphan_dead_owner')), false);
  assert.equal(existsSync(ownPath('sess_orphan_fresh_live')), true);
  assert.equal(existsSync(ownPath('sess_with_record')), true);
  assert.equal(tally.cleaned, 2);
});
