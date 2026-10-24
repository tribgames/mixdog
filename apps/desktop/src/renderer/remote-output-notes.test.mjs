import assert from 'node:assert/strict';
import test from 'node:test';

import { REMOTE_TRANSCRIPT_ROW_MAX_BYTES, remoteTranscriptSnapshot } from '../main/remote-transcript.ts';
import { remoteOutputNotice } from './remote-output-notes.ts';

const LONG = `HEAD-${'x'.repeat(30_000)}-TAIL exit code: 2`;

test('the host sends data and the phone writes the words', () => {
  const host = {
    items: [
      { id: 't1', kind: 'tool', name: 'shell', args: { command: 'build' }, result: LONG, rawResult: LONG },
      { id: 't2', kind: 'tool', name: 'read', args: { path: '/work/.env' }, result: 'API_TOKEN=sk-live-1' },
      {
        id: 'agg',
        kind: 'tool',
        aggregate: true,
        toolMembers: [{ id: 'm1', name: 'shell', result: LONG }],
      },
      { id: 't3', kind: 'tool', name: 'read', result: 'short' },
    ],
  };
  const phone = remoteTranscriptSnapshot(host);
  assert.doesNotMatch(JSON.stringify(phone), /omitted …|Output withheld/u);
  // Tool rows keep the text their header is parsed from; the note is its own line.
  const [cut, env, aggregate, plain] = phone.items;
  assert.match(remoteOutputNotice(cut), /^… \d+ characters omitted …$/u);
  // A secret-bearing read reaches the phone as the desktop shows it.
  assert.equal(env, host.items[1]);
  assert.equal(remoteOutputNotice(env), '');
  assert.match(remoteOutputNotice(aggregate.toolMembers[0]), /characters omitted/u);
  assert.equal(remoteOutputNotice(plain), '');
  const { remoteOutputTruncated: _cut, ...merged } = { ...cut, result: LONG };
  assert.equal(remoteOutputNotice(merged), '', 'a row holding its whole output (a full read) has no note');
  // A host from before parity withheld such a row; its note is still worded.
  const older = { ...host.items[1], result: '', remoteOutputNotes: { result: { kind: 'withheld' } } };
  assert.match(remoteOutputNotice(older), /^Output withheld: this tool call touches a secret file/u);
});

test('a message row over the per-row ceiling is sent whole', () => {
  const huge = `${'y'.repeat(200_000)}END`;
  const row = { id: 'u', kind: 'user', text: huge };
  const [sent] = remoteTranscriptSnapshot({ items: [row] }).items;
  assert.ok(Buffer.byteLength(JSON.stringify(sent)) > REMOTE_TRANSCRIPT_ROW_MAX_BYTES);
  assert.equal(sent, row, 'no cut, no note: message text has no way back');
});
