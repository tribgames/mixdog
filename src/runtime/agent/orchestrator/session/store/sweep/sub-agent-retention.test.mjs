// Sub-agent tree retention against a real temp store: which records the sweep
// names (with their stored activity time), and which whole trees applying it
// archives, deletes or leaves alone.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { settleSessionSummaryIndex } from '../listing.mjs';
import { sweepStaleSessions } from './stale-sweep.mjs';
import { applySubAgentRetention } from './sub-agent-retention.mjs';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const CONVERSATION = [
  { role: 'user', content: 'x' },
  { role: 'assistant', content: 'y' },
];
// A sub-agent under `parent`, its tree rooted at the Lead sess_lead.
const sub = (parent = 'sess_lead', extra = {}) => ({
  owner: 'agent',
  agent: 'worker',
  ownerSessionId: 'sess_lead',
  parentSessionId: parent,
  ...extra,
});

async function withStore(t, run) {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-sub-retention-'));
  const previous = process.env.MIXDOG_DATA_DIR;
  process.env.MIXDOG_DATA_DIR = root;
  const dir = join(root, 'sessions');
  mkdirSync(dir);
  t.after(async () => {
    await settleSessionSummaryIndex();
    if (previous === undefined) delete process.env.MIXDOG_DATA_DIR;
    else process.env.MIXDOG_DATA_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  });
  const now = Date.now();
  // `idle`: time since the last conversation turn (lastUsedAt).
  const write = (id, idle, doc = sub()) => {
    const at = now - idle;
    const path = join(dir, `${id}.json`);
    writeFileSync(
      path,
      JSON.stringify({ id, status: 'idle', createdAt: at, updatedAt: at, lastUsedAt: at, messages: CONVERSATION, ...doc })
    );
    const mtime = Math.max(at, Number(doc.updatedAt) || 0) / 1000;
    utimesSync(path, mtime, mtime);
  };
  const members = () => sweepStaleSessions({ retainSubAgents: true, isSessionLive: () => false }).subAgents;
  const flags = {};
  const calls = [];
  const apply = (list, options = {}) =>
    applySubAgentRetention(list, {
      isArchived: (id) => Object.hasOwn(flags, id),
      setSidebar: async (id, change) => calls.push([id, change]),
      ...options,
    });
  await run({ now, write, members, apply, flags, calls, exists: (id) => existsSync(join(dir, `${id}.json`)) });
}

test('the idle sweep names every sub-agent record with its stored activity, and nothing else', async (t) => {
  await withStore(t, async ({ now, write, members }) => {
    write('sess_fresh', 0);
    write('sess_old', 40 * DAY);
    // Detach/resume bookkeeping moved updatedAt an hour ago; no turn since.
    write('sess_bumped', 31 * DAY, sub('sess_lead', { updatedAt: now - HOUR }));
    write('sess_lead', 40 * DAY, { owner: 'user', agent: 'lead', ownerSessionId: 'sess_lead', visibility: 'agent-only' });
    write('sess_task', 40 * DAY, sub('sess_lead', { taskOrigin: { agentId: 'mailer', title: 'Fix' } }));
    write('sess_home_mailer', 40 * DAY, sub('sess_lead', { visibility: 'agent-only' }));
    write('sess_room_abc', 40 * DAY);
    write('sess_rmem_abc_mailer', 40 * DAY);
    write('sess_user_chat', 40 * DAY, { owner: 'user' });
    const byId = Object.fromEntries(members().map((member) => [member.id, member]));
    assert.deepEqual(Object.keys(byId).sort(), ['sess_bumped', 'sess_fresh', 'sess_old']);
    assert.equal(byId.sess_bumped.lastActive, now - 31 * DAY, 'lastUsedAt, not a bookkeeping updatedAt');
    assert.equal(byId.sess_old.parentId, 'sess_lead');
    // Only a caller that applies them gets them; never on a tombstone-only pass.
    assert.equal('subAgents' in sweepStaleSessions({ isSessionLive: () => false }), false);
    assert.equal('subAgents' in sweepStaleSessions({ sweepIdle: false, retainSubAgents: true }), false);
  });
});

test('an all-idle tree is archived together; one recently active or running member keeps its whole tree', async (t) => {
  await withStore(t, async ({ write, members, apply, calls, flags, exists }) => {
    write('sess_a', 4 * DAY);
    write('sess_a_child', 5 * DAY, sub('sess_a'));
    write('sess_a_grand', 6 * DAY, sub('sess_a_child'));
    flags.sess_a_grand = 1; // already archived: not archived again
    write('sess_b', 5 * DAY);
    write('sess_b_child', HOUR, sub('sess_b'));
    write('sess_c', 5 * DAY);
    write('sess_c_child', 5 * DAY, sub('sess_c'));
    const applied = await apply(members(), { isSessionLive: (id) => id === 'sess_c_child' });
    assert.deepEqual(applied, { archived: ['sess_a', 'sess_a_child'], deleted: [] });
    // Exactly these members, never a cascade past them.
    assert.deepEqual(calls, [
      ['sess_a', { archived: true, cascade: false }],
      ['sess_a_child', { archived: true, cascade: false }],
    ]);
    for (const id of ['sess_a', 'sess_a_child', 'sess_a_grand', 'sess_b', 'sess_b_child']) assert.ok(exists(id));
  });
});

test('an all-expired tree is deleted together; one member under 30 days makes it an archive', async (t) => {
  await withStore(t, async ({ write, members, apply, calls, flags, exists }) => {
    write('sess_d', 31 * DAY);
    write('sess_d_child', 40 * DAY, sub('sess_d'));
    flags.sess_d_child = 1;
    write('sess_e', 40 * DAY);
    write('sess_e_child', 10 * DAY, sub('sess_e'));
    const applied = await apply(members());
    assert.deepEqual(applied.deleted.sort(), ['sess_d', 'sess_d_child']);
    assert.deepEqual(applied.archived, ['sess_e', 'sess_e_child']);
    assert.equal(exists('sess_d') || exists('sess_d_child'), false);
    assert.ok(exists('sess_e') && exists('sess_e_child'));
    // The deleted member that was archived loses its flag.
    assert.deepEqual(
      calls.filter(([, change]) => change.forgotten),
      [['sess_d_child', { forgotten: true }]]
    );
  });
});

test('a member with a missing or invalid stored timestamp keeps its whole tree', async (t) => {
  await withStore(t, async ({ write, members, apply, calls, exists }) => {
    const unknown = { createdAt: undefined, updatedAt: undefined, lastUsedAt: undefined };
    write('sess_m', 40 * DAY);
    write('sess_m_child', 40 * DAY, sub('sess_m', unknown));
    write('sess_n', 40 * DAY);
    write('sess_n_child', 40 * DAY, sub('sess_n', { createdAt: null, updatedAt: -5, lastUsedAt: 'soon' }));
    write('sess_o', 5 * DAY, sub('sess_lead', unknown));
    const named = members();
    assert.equal(named.find((member) => member.id === 'sess_m_child').lastActive, 0);
    assert.deepEqual(await apply(named), { archived: [], deleted: [] });
    assert.deepEqual(await apply([{ id: 'sess_m', parentId: 'sess_lead', lastActive: Number.NaN }]), {
      archived: [],
      deleted: [],
    });
    for (const id of ['sess_m', 'sess_m_child', 'sess_n', 'sess_n_child', 'sess_o']) assert.ok(exists(id), id);
    assert.deepEqual(calls, []);
  });
});

test('a member active between the sweep and the action keeps its tree; without a desktop only deletes run', async (t) => {
  await withStore(t, async ({ write, members, apply, calls, exists }) => {
    write('sess_f', 40 * DAY);
    write('sess_f_child', 40 * DAY, sub('sess_f'));
    write('sess_g', 5 * DAY);
    write('sess_h', 40 * DAY);
    const named = members();
    write('sess_f_child', 0, sub('sess_f')); // a turn ran after the sweep read it
    const applied = await apply(named, { isArchived: null });
    assert.deepEqual(applied, { archived: [], deleted: ['sess_h'] });
    assert.ok(exists('sess_f') && exists('sess_f_child') && exists('sess_g'));
    assert.deepEqual(calls, []);
  });
});
