import assert from 'node:assert/strict';
import test from 'node:test';

import { readVisualizeInlineBody, resetVisualizeInlineBodies } from './visualize-inline-body.ts';

const at = { sessionId: 's1', tabId: 'i1', revision: 2, index: 0 };
const deferredPane = {
  kind: 'inline',
  label: 'Pipeline',
  target: 'Pipeline',
  url: '',
  inline: { kind: 'mermaid', source: '', title: 'Pipeline', deferred: true },
};

test('a left-out inline source is read once per tab revision and pane; a full one is used as is', async () => {
  resetVisualizeInlineBodies();
  const reads = [];
  const read = async (...args) => {
    reads.push(args);
    return { kind: 'mermaid', source: 'flowchart LR\n  A --> B', title: 'Pipeline' };
  };
  const first = await readVisualizeInlineBody(deferredPane, at, read);
  assert.equal(first.source, 'flowchart LR\n  A --> B');
  await readVisualizeInlineBody(deferredPane, at, read);
  assert.deepEqual(reads, [['s1', 'i1', 0]], 'the same revision is not read again');
  await readVisualizeInlineBody(deferredPane, { ...at, revision: 3 }, read);
  assert.equal(reads.length, 2, 'a new revision reads again');
  const full = { ...deferredPane, inline: { kind: 'svg', source: '<svg/>' } };
  assert.equal(await readVisualizeInlineBody(full, at, read), full.inline);
  assert.equal(reads.length, 2);
});

test('a failed read is not kept: the next showing asks again', async () => {
  resetVisualizeInlineBodies();
  let calls = 0;
  const failing = async () => {
    calls += 1;
    throw new Error('closed');
  };
  await assert.rejects(readVisualizeInlineBody(deferredPane, at, failing), /closed/);
  await assert.rejects(readVisualizeInlineBody(deferredPane, at, failing), /closed/);
  assert.equal(calls, 2);
});
