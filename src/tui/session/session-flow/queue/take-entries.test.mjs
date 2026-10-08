import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-take-entries-'));
process.env.MIXDOG_DATA_DIR = dataDir;
test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const { materializePromptSubmission } = await import('../../../../runtime/attachments/store.mjs');
const { createTakeEntriesOps } = await import('./take-entries.mjs');
const { createAbortAction } = await import('../../session-api/intake/abort.mjs');

function storedImage(label) {
  const intake = materializePromptSubmission(
    [{ type: 'image', data: Buffer.from(label).toString('base64'), mimeType: 'image/png' }],
    {}
  );
  return intake.prompt[0];
}

function entryWith(id, images) {
  return { id, text: `prompt ${id}`, mode: 'prompt', pastedImages: images };
}

test('restoreQueued drops only the missing attachment and never the prompt', () => {
  const kept = storedImage('kept image');
  const gone = { attachmentRef: createHash('sha256').update('never stored').digest('hex'), sizeBytes: 12 };
  const pending = [
    entryWith('a', { 1: { id: 1, type: 'image', ...kept } }),
    entryWith('b', { 2: { id: 2, type: 'image', ...gone } }),
  ];
  const removed = [];
  const { restoreQueued } = createTakeEntriesOps({
    pending,
    pendingNotificationKeys: new Set(),
    removeQueuedEntries: (entries) => removed.push(...entries),
  });
  const restored = restoreQueued('draft');
  assert.equal(restored.count, 2);
  assert.equal(restored.text, 'prompt a\nprompt b\ndraft');
  assert.deepEqual(Object.keys(restored.pastedImages), ['1']);
  assert.equal(restored.pastedImages[1].content, Buffer.from('kept image').toString('base64'));
  assert.match(restored.notice, /1 attachment was no longer available/);
  assert.equal(pending.length, 0);
  assert.equal(removed.length, 2);
});

test('reclaiming an idle submission that is still being accepted keeps the prompt without a missing attachment', () => {
  const gone = { attachmentRef: createHash('sha256').update('also never stored').digest('hex'), sizeBytes: 12 };
  const intake = {
    cancelled: false,
    queueOptions: { displayText: 'draft text', pastedImages: { 1: { id: 1, type: 'image', ...gone } } },
  };
  const { abort } = createAbortAction(
    {
      runtime: {},
      flags: {},
      pending: [],
      getState: () => ({ busy: false }),
      set() {},
      replaceItems() {},
      denyAllToolApprovals() {},
      requeueEntriesFront() {},
      restoreQueued: () => ({ count: 0 }),
      drain() {},
      discardExecutionPendingResume() {},
    },
    { acceptingSubmissions: new Map([['s1', intake]]) }
  );
  const result = abort({ submissionId: 's1' });
  assert.equal(result.restoreText, 'draft text');
  assert.deepEqual(result.pastedImages, {});
  assert.match(result.notice, /no longer available/);
  assert.equal(intake.cancelled, true);
});

test('restore returns file attachments hydrated to base64 and drops only a missing one', () => {
  const [pdf, sheet] = ['%PDF-1.4 restore me', 'sheet bytes'].map(
    (text, index) =>
      materializePromptSubmission([
        {
          type: 'file',
          data: Buffer.from(text).toString('base64'),
          mimeType: index === 0 ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          filename: index === 0 ? 'spec.pdf' : 'kpi.xlsx',
        },
      ]).prompt[0]
  );
  const gone = {
    type: 'file',
    mimeType: 'application/pdf',
    filename: 'lost.pdf',
    attachmentRef: createHash('sha256').update('lost pdf').digest('hex'),
    sizeBytes: 8,
  };
  const pending = [{ id: 'f', text: '[PDF #1: spec.pdf] [File #2: kpi.xlsx] [PDF #3: lost.pdf]', mode: 'prompt', content: [pdf, sheet, gone] }];
  const { restoreQueued } = createTakeEntriesOps({
    pending,
    pendingNotificationKeys: new Set(),
    removeQueuedEntries() {},
  });
  const restored = restoreQueued('');
  assert.equal(restored.count, 1);
  assert.deepEqual(restored.content, [
    { type: 'file', data: Buffer.from('%PDF-1.4 restore me').toString('base64'), mimeType: 'application/pdf', filename: 'spec.pdf' },
    {
      type: 'file',
      data: Buffer.from('sheet bytes').toString('base64'),
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      filename: 'kpi.xlsx',
    },
  ]);
  assert.match(restored.notice, /1 attachment was no longer available/);
  assert.equal(restored.text.includes('lost.pdf'), true, 'the prompt text is kept');
});

test('reclaiming an accepting submission returns its inline file parts', () => {
  const data = Buffer.from('%PDF-1.4 inline').toString('base64');
  const intake = {
    cancelled: false,
    text: [{ type: 'text', text: '[PDF #1: a.pdf]' }, { type: 'file', data, mimeType: 'application/pdf', filename: 'a.pdf' }],
    queueOptions: { displayText: '[PDF #1: a.pdf]' },
  };
  const { abort } = createAbortAction(
    {
      runtime: {},
      flags: {},
      pending: [],
      getState: () => ({ busy: false }),
      set() {},
      replaceItems() {},
      denyAllToolApprovals() {},
      requeueEntriesFront() {},
      restoreQueued: () => ({ count: 0 }),
      drain() {},
      discardExecutionPendingResume() {},
    },
    { acceptingSubmissions: new Map([['s2', intake]]) }
  );
  assert.deepEqual(abort({ submissionId: 's2' }).content, [
    { type: 'file', data, mimeType: 'application/pdf', filename: 'a.pdf' },
  ]);
});
