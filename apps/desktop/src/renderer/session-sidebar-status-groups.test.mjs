import assert from 'node:assert/strict';
import test from 'node:test';

import { commitShownOrder } from './session-order.ts';
import { placeStatusSessions, restingRows, sidebarStatusGroup } from './session-sidebar-status-groups.ts';

const ALL = new Set(['favorites', 'needs', 'working']);
// Newest first, the way the sidebar hands its unarchived rows over.
const activity = [
  ...['run', 'ask', 'quiet-a', 'approve', 'fail', 'project-quiet', 'wait', 'seen', 'quiet-b'].map((id) => ({ id })),
  { id: 'star-quiet', favorite: true },
  { id: 'star-asking', favorite: true },
];
const ATTENTION = {
  run: 'running',
  ask: 'asking',
  approve: 'needs-you',
  fail: 'failed',
  wait: 'waiting',
  seen: 'unread',
  'star-asking': 'asking',
};
const ids = (rows) => rows.map((row) => row.id);
const attentionOf = (id) => ATTENTION[id] ?? '';

test('확인 필요 takes approvals, questions, failures and unread turns; 작업 중 the running and waiting ones', () => {
  assert.deepEqual(['needs-you', 'asking', 'failed', 'unread', 'running', 'waiting', ''].map(sidebarStatusGroup), [
    'needs',
    'needs',
    'needs',
    'needs',
    'working',
    'working',
    '',
  ]);
  const placement = placeStatusSessions(activity, attentionOf, ALL);
  assert.deepEqual(placement.needs, ['ask', 'approve', 'fail', 'seen']);
  assert.deepEqual(placement.working, ['run', 'wait']);
  // A favourite keeps to 즐겨찾기 with its own mark.
  assert.deepEqual(placement.favorites, ['star-quiet', 'star-asking']);
  assert.deepEqual(ids(restingRows(activity, placement)), ['quiet-a', 'project-quiet', 'quiet-b']);
});

test('a hidden group takes no session, so its sessions rest where they would', () => {
  const placement = placeStatusSessions(activity, attentionOf, new Set(['favorites', 'working']));
  assert.deepEqual(placement.needs, []);
  assert.deepEqual(placement.working, ['run', 'wait']);
  assert.deepEqual(ids(restingRows(activity, placement)), [
    'ask',
    'quiet-a',
    'approve',
    'fail',
    'project-quiet',
    'seen',
    'quiet-b',
  ]);
  // With 즐겨찾기 hidden a favourite is an ordinary session: placed by its status, else resting.
  const unstarred = placeStatusSessions(activity, attentionOf, new Set(['needs', 'working']));
  assert.deepEqual(unstarred.favorites, []);
  assert.deepEqual(unstarred.needs, ['ask', 'approve', 'fail', 'seen', 'star-asking']);
  assert.deepEqual(ids(restingRows(activity, unstarred)), ['quiet-a', 'project-quiet', 'quiet-b', 'star-quiet']);
});

test('the placement stays the same object until a session changes group', () => {
  const first = placeStatusSessions(activity, attentionOf, ALL);
  // running -> waiting stays in 작업 중: nothing moves.
  const same = placeStatusSessions(activity, (id) => (id === 'run' ? 'waiting' : attentionOf(id)), ALL, first);
  assert.equal(same, first);
  const finished = placeStatusSessions(activity, (id) => (id === 'run' ? '' : attentionOf(id)), ALL, first);
  assert.notEqual(finished, first);
  assert.deepEqual(finished.working, ['wait']);
  assert.equal(finished.placed.has('run'), false);
});

test('a session being renamed keeps its group while its status changes', () => {
  const first = placeStatusSessions(activity, attentionOf, ALL);
  const nextAttention = { ...ATTENTION, run: 'unread', 'quiet-a': 'running' };
  const status = (id) => nextAttention[id] ?? '';
  const held = placeStatusSessions(activity, status, ALL, first, new Set(['run', 'quiet-a']));
  assert.equal(held, first);
  const released = placeStatusSessions(activity, status, ALL, held);
  assert.deepEqual(released.working, ['quiet-a', 'wait']);
  assert.deepEqual(released.needs, ['run', 'ask', 'approve', 'fail', 'seen']);
});

test('최근 keeps the resting sessions without a project; a folder its own resting ones', () => {
  const placement = placeStatusSessions(activity, attentionOf, ALL);
  const projectKeys = new Map([
    ['project-quiet', 'p'],
    ['approve', 'p'],
    ['star-quiet', 'p'],
  ]);
  assert.deepEqual(ids(restingRows(activity, placement, projectKeys)), ['quiet-a', 'quiet-b']);
  const folder = activity.filter((row) => projectKeys.has(row.id));
  assert.deepEqual(ids(restingRows(folder, placement)), ['project-quiet']);
});

test('reordering the shown part of a list keeps the places of sessions shown elsewhere', () => {
  // Full custom order of 최근: b and d sit in a status group right now.
  assert.deepEqual(commitShownOrder(['a', 'b', 'c', 'd', 'e'], ['e', 'a', 'c']), ['e', 'b', 'a', 'd', 'c']);
  assert.deepEqual(commitShownOrder(['a', 'b'], ['b', 'a']), ['b', 'a']);
});
