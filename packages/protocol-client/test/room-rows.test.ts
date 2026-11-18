// A stored room line (`type: 'roomRow'`, the core's room log) as the row a client shows (`roomRowItem` in rows.ts): the user's bubble,
// or a notice whose `room` payload the app renders as a speech, pass or limit line. Inputs are inline; expectations follow the rule.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Obj } from '../src/obj.ts';
import { rowOf } from '../src/rows.ts';

const row = (item: Obj): Obj => {
  const shown = rowOf(item);
  assert.ok(shown, 'a room line has a row');
  return shown;
};

test('a user row keeps its addressees as an ordered id/name list; a single older id reads the same', () => {
  const legacy = row({ type: 'roomRow', id: 'i1', room: { kind: 'user', to: 'gh', toName: 'GH' }, text: 'x', meta: {} });
  assert.deepEqual(legacy.room, { kind: 'user', to: ['gh'], toName: ['GH'] });
  const listed = row({ type: 'roomRow', id: 'i2', room: { kind: 'user', to: ['b', 'a'], toName: ['B'] }, text: 'x', meta: {} });
  // A missing name falls back to the id.
  assert.deepEqual(listed.room, { kind: 'user', to: ['b', 'a'], toName: ['B', 'a'] });
  assert.equal(listed.kind, 'user');
  assert.equal(listed.text, 'x');
});

test('a user row takes the message id and time from meta, and shows a row from another session with its sender', () => {
  const own = row({ type: 'roomRow', id: 'i1', room: { kind: 'user', to: ['gh'] }, text: 'hi', meta: { messageId: 'm1', at: 1800000000000 } });
  assert.equal(own.id, 'm1');
  assert.equal(own.messageId, 'm1');
  assert.equal(own.at, 1800000000000);
  assert.equal('sender' in own || 'fromAgent' in own, false);
  assert.deepEqual(own.room, { kind: 'user', to: ['gh'], toName: ['gh'], id: 'm1', at: 1800000000000 });

  const fromBot = row({ type: 'roomRow', id: 'i2', room: { kind: 'user', fromSession: 's1', fromAgent: 'rel', fromName: 'Release', to: ['gh'] }, text: 'status?', meta: {} });
  assert.equal(fromBot.fromAgent, 'rel');
  assert.equal('sender' in fromBot, false);
  const fromLead = row({ type: 'roomRow', id: 'i3', room: { kind: 'user', fromSession: 's1', to: ['gh'] }, text: 'status?', meta: {} });
  assert.equal(fromLead.sender, 'lead');
  assert.equal('fromAgent' in fromLead, false);
});

test('a user row keeps valid reactions only, one per agent', () => {
  const shown = row({
    type: 'roomRow',
    id: 'i1',
    room: { kind: 'user' },
    text: 'x',
    reactions: [{ agentId: 'gh', emoji: '👍', at: 5 }, { agentId: 'gh', emoji: '🎉' }, { agentId: 'bad id', emoji: '👍' }, { agentId: 'rel', emoji: '' }],
    meta: {},
  });
  assert.deepEqual(shown.reactions, [{ agentId: 'gh', emoji: '👍', at: 5 }]);
});

test('peer speech, pass and limit lines restore as info notices with their own text', () => {
  const speech = row({ type: 'roomRow', id: 'h2', room: { kind: 'speech', name: 'GH' }, text: 'done', meta: {} });
  assert.deepEqual([speech.kind, speech.tone, speech.id, speech.text], ['notice', 'info', 'h2', 'done']);
  assert.equal(row({ type: 'roomRow', id: 'p1', room: { kind: 'pass', name: 'GH' }, text: '', meta: {} }).text, 'GH · pass');
  assert.equal(row({ type: 'roomRow', id: 'p2', room: { kind: 'pass', names: ['A', 'B'], failed: true }, text: '', meta: {} }).text, 'A, B · no reply');
  assert.equal(row({ type: 'roomRow', id: 'p3', room: { kind: 'pass' }, text: '', meta: {} }).text, 'agent · pass');
  assert.equal(row({ type: 'roomRow', id: 'c1', room: { kind: 'cap' }, text: '', meta: {} }).text, 'Stopped at the room limit. Continue to run another batch.');
  assert.equal(row({ type: 'roomRow', id: 'c2', room: { kind: 'cap', usage: true }, text: '', meta: {} }).text, 'Paused: the usage limit was reached.');
  assert.equal(row({ type: 'roomRow', id: 's1', room: { kind: 'stopped' }, text: '', meta: {} }).text, 'Stopped.');
  assert.equal(row({ type: 'roomRow', id: 's2', room: { kind: 'other' }, text: '', meta: {} }).text, 'Interrupted.');
});

test('a user or speech row keeps well-formed attachments only: de-duplicated, bare hash id, defaults, at most 64; notices of other kinds keep none', () => {
  const A = 'a'.repeat(64);
  const B = 'b'.repeat(64);
  const files: Obj[] = [
    { id: A, kind: 'image', name: 'a.png', mimeType: 'image/png', size: 12, original: { attachmentRef: B, mimeType: 'image/jpeg' } },
    { id: A, kind: 'file', name: 'dup' },
    { id: 'not-a-hash', name: 'bad' },
    { id: B, kind: 'weird', size: -4 },
  ];
  const user = row({ type: 'roomRow', id: 'i1', room: { kind: 'user' }, text: 'x', attachments: files, meta: {} });
  assert.deepEqual(user.attachments, [
    { id: A, attachmentRef: A, kind: 'image', name: 'a.png', mimeType: 'image/png', size: 12, original: { attachmentRef: B, mimeType: 'image/jpeg' } },
    { id: B, attachmentRef: B, kind: 'file', name: 'attachment', mimeType: 'application/octet-stream', size: 0 },
  ]);
  const speech = row({ type: 'roomRow', id: 'i2', room: { kind: 'speech', name: 'GH' }, text: 'made it', attachments: [files[0] as Obj], meta: {} });
  assert.deepEqual((speech.attachments as Obj[]).map((f) => f.id), [A]);
  const pass = row({ type: 'roomRow', id: 'i3', room: { kind: 'pass', name: 'GH' }, text: '', attachments: files, meta: {} });
  assert.equal('attachments' in pass, false);
  const none = row({ type: 'roomRow', id: 'i4', room: { kind: 'user' }, text: 'x', attachments: [{ id: 'bad' }], meta: {} });
  assert.equal('attachments' in none, false);
  const many = row({ type: 'roomRow', id: 'i5', room: { kind: 'user' }, text: 'x', attachments: Array.from({ length: 70 }, (_, i) => ({ id: i.toString(16).padStart(64, '0') })), meta: {} });
  assert.equal((many.attachments as Obj[]).length, 64);
});

test('a user row keeps its image chips; a notice does not', () => {
  const images = [{ src: 'blob:1' }];
  assert.deepEqual(row({ type: 'roomRow', id: 'i1', room: { kind: 'user' }, text: 'x', images, meta: {} }).images, images);
  assert.equal('images' in row({ type: 'roomRow', id: 'i2', room: { kind: 'speech' }, text: 'x', images, meta: {} }), false);
});
