import assert from 'node:assert/strict';
import test from 'node:test';
import { BrowserGuestStateStore } from './guest-state.ts';
import { createBrowserLocalPrompts } from './local-prompts.ts';

/** A state view over one record, as the record's own page sees it. */
const recordState = (record) => ({
  for: () => record,
  blockingDialog: (guest) => (record.pendingDialog ? { owner: guest, dialog: record.pendingDialog } : null),
  invalidateInteraction() {},
});

test("a site's permission request is a prompt only the pane answers, after the page's own dialog", async () => {
  const record = { pendingDialog: null, dismissedDialog: null };
  const answers = [];
  let pending = { id: 'permission_1', origin: 'https://site.test', keys: ['notifications'] };
  const service = createBrowserLocalPrompts({
    state: recordState(record),
    controller: () => 's1',
    dialogs: {},
    uploads: {},
    chooseFiles: async () => ({ canceled: true, filePaths: [] }),
    permissions: {
      pending: () => pending,
      answer: (_guest, id, allow) => {
        answers.push([id, allow]);
        if (id !== pending?.id) return false;
        pending = undefined;
        return true;
      },
    },
  });
  record.pendingDialog = { type: 'alert', message: 'first', openedAt: 0 };
  assert.equal(service.describe({}).dialog.type, 'alert', 'a blocking dialog comes first');
  record.pendingDialog = null;
  assert.deepEqual(service.describe({}).dialog, {
    id: 'permission_1',
    type: 'permission',
    message: '',
    permission: { origin: 'https://site.test', keys: ['notifications'] },
  });
  await assert.rejects(
    service.answer({}, { type: 'answer-dialog', requestId: 'permission_0', accept: true }, () => {}),
    /prompt changed/
  );
  await service.answer({}, { type: 'answer-dialog', requestId: 'permission_1', accept: true }, () => {});
  assert.deepEqual(answers.at(-1), ['permission_1', true]);
  assert.equal(service.describe({}).dialog, undefined);
});

test('file selection cannot cross document, prompt, cancellation, or ownership changes, and cancel preserves files', async () => {
  for (const reason of ['document', 'prompt', 'signal', 'cancel', 'valid']) {
    const chooser = { mode: 'selectSingle' };
    const record = { pendingFileChooser: chooser, pendingDialog: null };
    const sent = [];
    const controller = new AbortController();
    let current = true;
    const service = createBrowserLocalPrompts({
      state: recordState(record),
      controller: () => 's1',
      dialogs: {},
      chooseFiles: async () => {
        if (reason === 'document') current = false;
        if (reason === 'prompt') record.pendingFileChooser = {};
        if (reason === 'signal') controller.abort(new Error('cancelled'));
        return { canceled: reason === 'cancel', filePaths: ['/chosen/file'] };
      },
      uploads: {
        uploadRef: async (_guest, _ref, paths, _signal, guard) => {
          guard();
          sent.push(paths);
        },
      },
    });
    const shown = service.describe({});
    const work = service.answer(
      {},
      { type: 'choose-files', requestId: shown.fileChooser.id },
      () => {
        if (!current) throw new Error('document changed');
      },
      controller.signal
    );
    if (['cancel', 'valid'].includes(reason)) await work;
    else await assert.rejects(work);
    assert.equal(sent.length, reason === 'valid' ? 1 : 0);
    if (reason === 'cancel') assert.equal(record.pendingFileChooser, null);
  }
});

test('a second file choice cannot open another native picker for the same prompt', async () => {
  const record = { pendingFileChooser: { mode: 'selectMultiple' } };
  const { promise, resolve } = Promise.withResolvers();
  let calls = 0;
  const service = createBrowserLocalPrompts({
    state: recordState(record),
    controller: () => 's1',
    dialogs: {},
    uploads: {},
    chooseFiles: () => {
      calls++;
      return promise;
    },
  });
  const input = { type: 'choose-files', requestId: service.describe({}).fileChooser.id };
  const first = service.answer({}, input, () => {});
  await assert.rejects(
    service.answer({}, input, () => {}),
    /already open/
  );
  resolve({ canceled: true, filePaths: [] });
  await first;
  assert.equal(calls, 1);
});

test('dialog answers use the exact displayed request and revalidate before dispatch', async () => {
  const record = { pendingDialog: { type: 'prompt', message: 'Reply?', defaultPrompt: 'default' } };
  let guard;
  const service = createBrowserLocalPrompts({
    state: recordState(record),
    controller: () => 's1',
    uploads: {},
    chooseFiles: async () => {
      throw new Error('unexpected');
    },
    dialogs: {
      handleDialog: async (_guest, accept, text, _signal, check) => {
        assert.equal(accept, true);
        assert.equal(text, 'answer');
        guard = check;
        check();
      },
    },
  });
  const shown = service.describe({}).dialog;
  await service.answer(
    {},
    { type: 'answer-dialog', requestId: shown.id, accept: true, promptText: 'answer' },
    () => {}
  );
  record.pendingDialog = { type: 'confirm' };
  assert.throws(guard, /prompt changed/);
  await assert.rejects(
    service.answer({}, { type: 'answer-dialog', requestId: shown.id }, () => {}),
    /prompt changed/
  );
});

/** A popup and its opener sharing one renderer, the opener with a dialog open,
 *  controlled by the sessions named (undefined: none). */
function sharedRenderer(popupSession, openerSession) {
  const popup = { name: 'popup' };
  const opener = { name: 'opener' };
  const sessions = new Map([
    [popup, popupSession],
    [opener, openerSession],
  ]);
  const state = new BrowserGuestStateStore((guest) => (guest === popup ? [opener] : [popup]));
  const answered = [];
  const service = createBrowserLocalPrompts({
    state,
    controller: (guest) => sessions.get(guest),
    uploads: {},
    chooseFiles: async () => assert.fail('unexpected'),
    dialogs: {
      handleDialog: async (guest, accept, text, _signal, check) => {
        check();
        answered.push([guest.name, accept, text]);
        state.for(guest).pendingDialog = null;
      },
    },
  });
  state.for(opener).pendingDialog = { type: 'prompt', message: 'Name?', defaultPrompt: 'Ann', openedAt: 0 };
  state.for(popup).pendingFileChooser = { mode: 'selectSingle', openedAt: 0 };
  return { popup, opener, state, service, answered };
}

test("a renderer peer's dialog is shown and answered from a page of the session that controls it", async () => {
  const same = sharedRenderer('s1', 's1');
  const shown = same.service.describe(same.popup);
  assert.deepEqual(shown.dialog, {
    id: shown.dialog.id,
    type: 'prompt',
    message: 'Name?',
    defaultPrompt: 'Ann',
  });
  assert.equal(shown.fileChooser.multiple, false, "the page's own file chooser stays");
  await same.service.answer(
    same.popup,
    { type: 'answer-dialog', requestId: shown.dialog.id, accept: true, promptText: 'Bo' },
    () => {}
  );
  assert.deepEqual(same.answered, [['opener', true, 'Bo']], 'the answer reaches the dialog page');
  assert.equal(same.service.describe(same.popup).dialog, undefined, 'answered');
});

test("another session's dialog blocks the view without its content or an answer", async () => {
  for (const popupSession of ['s2', undefined]) {
    const f = sharedRenderer(popupSession, 's1');
    const shown = f.service.describe(f.popup).dialog;
    assert.deepEqual(shown, { id: shown.id, type: 'blocked', message: '' }, 'no message, default or type');
    await assert.rejects(
      f.service.answer(
        f.popup,
        { type: 'answer-dialog', requestId: shown.id, accept: true, promptText: 'x' },
        () => {}
      ),
      /another session's page/
    );
    assert.deepEqual(f.answered, []);
    assert.equal(f.state.for(f.opener).pendingDialog.message, 'Name?', 'still pending: its own session answers it');
    assert.equal(f.service.describe(f.opener).dialog.message, 'Name?', 'the dialog page itself shows it');
  }
});

test('a dialog dismissed unseen is a notice the pane acknowledges, below a real dialog', async () => {
  const state = new BrowserGuestStateStore();
  const page = {};
  const service = createBrowserLocalPrompts({
    state,
    controller: () => 's1',
    uploads: {},
    dialogs: {},
    chooseFiles: async () => assert.fail('unexpected'),
  });
  assert.equal(service.describe(page).dialog, undefined);
  state.noteDismissedDialog(page, { type: 'alert', message: 'Saved' }, 'unreachable');
  const notice = service.describe(page).dialog;
  assert.deepEqual(notice, { id: notice.id, type: 'dismissed', message: '' });
  state.for(page).pendingDialog = { type: 'confirm', message: 'Sure?', openedAt: 0 };
  assert.equal(service.describe(page).dialog.type, 'confirm', 'an open dialog comes first');
  state.for(page).pendingDialog = null;
  await assert.rejects(
    service.answer(page, { type: 'answer-dialog', requestId: 'prompt_999', accept: true }, () => {}),
    /prompt changed/
  );
  await service.answer(page, { type: 'answer-dialog', requestId: notice.id, accept: true }, () => {});
  assert.equal(service.describe(page).dialog, undefined, 'acknowledged');
  state.noteDismissedDialog(page, { type: 'prompt', message: 'Again' }, 'early');
  assert.notEqual(service.describe(page).dialog.id, notice.id, 'a later dismissal is a new notice');
});
