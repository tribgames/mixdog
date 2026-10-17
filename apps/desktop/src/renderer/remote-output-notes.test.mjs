import assert from 'node:assert/strict';
import test from 'node:test';

import { remoteTranscriptSnapshot } from '../main/remote-transcript.ts';
import { localizeRemoteOutputNotes } from './remote-output-notes.ts';

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
  const phone = remoteTranscriptSnapshot(host, '/work');
  assert.doesNotMatch(JSON.stringify(phone), /omitted …|Output withheld/u);
  const shown = localizeRemoteOutputNotes(phone);
  const [cut, withheld, aggregate, plain] = shown.items;
  assert.match(cut.result, /^HEAD-x+\n\[… \d+ characters omitted …\]\nx+-TAIL exit code: 2$/u);
  assert.equal(cut.rawResult, cut.result);
  assert.equal(cut.result.replace(/\n\[… \d+ characters omitted …\]\n/u, ''), phone.items[0].result);
  assert.equal('remoteOutputNotes' in cut, false);
  assert.equal(cut.remoteOutputTruncated, LONG.length, 'the row revision still sees the cut');
  assert.match(withheld.result, /^Output withheld: this tool call touches a secret file/u);
  assert.doesNotMatch(JSON.stringify(shown), /sk-live/u);
  assert.match(aggregate.toolMembers[0].result, /characters omitted/u);
  assert.equal(plain, host.items[3]);
  assert.equal(localizeRemoteOutputNotes(phone).items[0], shown.items[0], 'a row is localized once');
  const whole = { items: [host.items[3]] };
  assert.equal(localizeRemoteOutputNotes(whole), whole);
  assert.equal(localizeRemoteOutputNotes(null), null);
});
