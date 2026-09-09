import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrowserLocalPrompts } from './local-prompts.ts';

test('file selection cannot cross document, prompt, cancellation, or ownership changes, and cancel preserves files', async () => {
  for (const reason of ['document', 'prompt', 'signal', 'cancel', 'valid']) {
    const chooser = { mode: 'selectSingle' };
    const record = { pendingFileChooser: chooser, pendingDialog: null };
    const sent = [];
    const controller = new AbortController();
    let current = true;
    const service = createBrowserLocalPrompts({
      state: { for: () => record },
      dialogs: {},
      chooseFiles: async () => {
        if (reason === 'document') current = false;
        if (reason === 'prompt') record.pendingFileChooser = {};
        if (reason === 'signal') controller.abort(new Error('cancelled'));
        return { canceled: reason === 'cancel', filePaths: ['/chosen/file'] };
      },
      uploads: { uploadRef: async (_guest, _ref, paths, _signal, guard) => { guard(); sent.push(paths); } },
    });
    const shown = service.describe({});
    const work = service.answer({}, { type: 'choose-files', requestId: shown.fileChooser.id },
      () => { if (!current) throw new Error('document changed'); }, controller.signal);
    if (['cancel', 'valid'].includes(reason)) await work;
    else await assert.rejects(work);
    assert.equal(sent.length, reason === 'valid' ? 1 : 0);
    if (reason === 'cancel') assert.equal(record.pendingFileChooser, null);
  }
});

test('a second file choice cannot open another native picker for the same prompt', async () => {
  const record = { pendingFileChooser: { mode: 'selectMultiple' } };
  let resolve;
  let calls = 0;
  const service = createBrowserLocalPrompts({
    state: { for: () => record }, dialogs: {}, uploads: {},
    chooseFiles: () => { calls++; return new Promise(done => { resolve = done; }); },
  });
  const input = { type: 'choose-files', requestId: service.describe({}).fileChooser.id };
  const first = service.answer({}, input, () => {});
  await assert.rejects(service.answer({}, input, () => {}), /already open/);
  resolve({ canceled: true, filePaths: [] });
  await first;
  assert.equal(calls, 1);
});

test('dialog answers use the exact displayed request and revalidate before dispatch', async () => {
  const record = { pendingDialog: { type: 'prompt', message: 'Reply?', defaultPrompt: 'default' } };
  let guard;
  const service = createBrowserLocalPrompts({
    state: { for: () => record }, uploads: {}, chooseFiles: async () => { throw new Error('unexpected'); },
    dialogs: { handleDialog: async (_guest, accept, text, _signal, check) => {
      assert.equal(accept, true);
      assert.equal(text, 'answer');
      guard = check;
      check();
    } },
  });
  const shown = service.describe({}).dialog;
  await service.answer({}, { type: 'answer-dialog', requestId: shown.id, accept: true, promptText: 'answer' }, () => {});
  record.pendingDialog = { type: 'confirm' };
  assert.throws(guard, /prompt changed/);
  await assert.rejects(service.answer({}, { type: 'answer-dialog', requestId: shown.id }, () => {}), /prompt changed/);
});
