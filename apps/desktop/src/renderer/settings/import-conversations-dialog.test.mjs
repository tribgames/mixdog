import assert from 'node:assert/strict';
import test from 'node:test';

import React, { act } from 'react';
import { installTestDom } from '../test-support/test-dom.mjs';

const { dom } = installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: { url: 'https://mixdog.test/' },
  expose: ['HTMLElement', 'HTMLInputElement', 'CustomEvent', 'Event'],
  actEnvironment: false,
});
globalThis.React = React;
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
window.HTMLElement.prototype.attachEvent = () => {};
window.HTMLElement.prototype.detachEvent = () => {};
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

const { createRoot } = await import('react-dom/client');
const { ImportConversationsDialog, adoptImportJob } = await import('./import-conversations-dialog.tsx');
const model = await import('./import-conversations-model.ts');

const row = (id, importedSessionId = null) => ({
  id,
  source: 'codex',
  title: `Conversation ${id}`,
  cwd: `C:\\Project\\${id}`,
  modifiedAt: Date.now() - 1000,
  messageCount: id === 'c' ? null : 12,
  importedSessionId,
  warnings: [],
});

const job = (overrides = {}) => ({
  jobId: 'job-1',
  seq: 1,
  state: 'running',
  total: 2,
  processed: 0,
  imported: 0,
  skippedAlreadyImported: 0,
  failed: 0,
  byProject: [],
  results: [],
  ...overrides,
});

test('button label: one row continues, several rows import a batch', () => {
  assert.equal(model.importButtonLabel(1), 'Import and continue');
  assert.equal(model.importButtonLabel(3), 'Import 3');
  assert.equal(model.importButtonLabel(0), 'Import');
});

test('select all is mixed over a partial selection and clears when fully checked', () => {
  const rows = [row('a'), row('b'), row('c')];
  let selection = model.EMPTY_IMPORT_SELECTION;
  assert.equal(model.selectAllState(selection, 3), 'none');
  selection = model.toggleImportRow(selection, rows[0]);
  assert.equal(model.selectAllState(selection, 3), 'mixed');
  selection = model.toggleSelectAll(selection, 3);
  assert.equal(model.selectAllState(selection, 3), 'all');
  assert.equal(model.selectedImportCount(selection, 3), 3);
  selection = model.toggleImportRow(selection, rows[1]);
  assert.equal(model.selectAllState(selection, 3), 'mixed');
  assert.deepEqual(model.importSelectionPayload(selection, 'view-1'), { viewId: 'view-1', excludeIds: ['b'] });
  selection = model.toggleSelectAll(model.toggleSelectAll(selection, 3), 3);
  assert.equal(model.selectAllState(selection, 3), 'none');
  assert.deepEqual(model.importSelectionPayload(model.toggleImportRow(selection, rows[2]), 'view-1'), { ids: ['c'] });
});

test('an already-imported row cannot be selected', () => {
  const imported = row('x', 'session-1');
  const selection = model.toggleImportRow(model.EMPTY_IMPORT_SELECTION, imported);
  assert.equal(selection.ids.size, 0);
  assert.equal(model.isRowSelected({ all: true, ids: new Set() }, imported), false);
});

test('engine codes map to messages and an unknown code falls back', () => {
  const codes = [
    'viewExpired',
    'invalidCursor',
    'invalidPath',
    'unsupported',
    'unreadable',
    'jobNotFound',
    'empty',
    'malformed',
    'unknownCandidate',
    'noModelRoute',
    'cwdMissing',
    'imageOmitted',
    'tooLarge',
    'internalRecord',
    'historyPartial',
    'historySizeLimit',
    'historyUnavailable',
    'needsNewerNode',
  ];
  for (const code of codes) {
    assert.equal(model.importCodeFromError(new Error(`x ${code} y`)), code);
    assert.notEqual(model.importCodeMessage(code), model.importCodeMessage('mystery'));
  }
  assert.equal(model.importCodeFromError(new Error('import failed: malformed')), 'malformed');
});

test('progress snapshots never move a tracked job backwards', () => {
  const current = job({ seq: 5, processed: 1 });
  assert.equal(adoptImportJob(current, job({ seq: 4 })), current);
  assert.equal(adoptImportJob(null, job({ state: 'completed' })), null);
  assert.equal(adoptImportJob(null, job()).jobId, 'job-1');
});

async function mount(t, { rows, calls, api = {}, invoke, complete = true }) {
  const previous = window.mixdogDesktop;
  window.mixdogDesktop = {
    setTitleBarDimmed() {},
    rendererDiagnostic() {},
    listProjects: async () => [],
    addProject: async () => undefined,
    readCapabilities: async ([request]) => {
      calls.push(['read', request.capability, request.args[0]]);
      return [
        {
          ok: true,
          value: {
            searchedRoot: 'C:\\Users\\me\\.codex\\sessions',
            viewId: 'view-1',
            complete,
            matchedCount: rows.length,
            selectableCount: rows.filter((entry) => !entry.importedSessionId).length,
            projects: [],
            rows,
            nextCursor: null,
          },
        },
      ];
    },
    ...api,
    invokeCapability: async ({ capability, args }) => {
      calls.push(['invoke', capability, args[0]]);
      const custom = invoke?.(capability, args[0]);
      if (custom !== undefined) return { value: custom };
      if (capability === 'getConversationImportJobs') return { value: { jobs: [] } };
      return { value: job() };
    },
  };
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(React.createElement(ImportConversationsDialog, { onClose() {} })));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
    window.mixdogDesktop = previous;
  });
  return host;
}

const click = (element) => act(async () => element.click());
const primary = (host) => host.querySelector('footer button.primary');

test('dialog: labels follow the selection, select-all is mixed', async (t) => {
  const calls = [];
  const host = await mount(t, { rows: [row('a'), row('b'), row('c')], calls });
  const boxes = [...host.querySelectorAll('.settings-import-item > input')];
  assert.equal(boxes.length, 3);
  assert.doesNotMatch(host.textContent, /already imported/);
  assert.equal(primary(host).disabled, true);

  await click(boxes[0]);
  assert.equal(primary(host).textContent, 'Import and continue');
  const selectAll = host.querySelector('.settings-import-select-all input');
  assert.equal(selectAll.indeterminate, true);

  await click(boxes[1]);
  assert.equal(primary(host).textContent, 'Import 2');
  assert.equal(selectAll.indeterminate, true);
  await click(boxes[2]);
  assert.equal(primary(host).textContent, 'Import 3');
  assert.equal(selectAll.indeterminate, false);
  assert.equal(selectAll.checked, true);

  await click(boxes[1]);
  await click(selectAll);
  assert.equal(
    boxes.every((box) => box.checked),
    true
  );

  await click(boxes[0]);
  await click(primary(host));
  const start = calls.find((call) => call[1] === 'startConversationImport');
  assert.deepEqual(start[2].selection, { viewId: 'view-1', excludeIds: ['a'] });
});

test('dialog: an empty scan names the searched folder', async (t) => {
  const calls = [];
  const host = await mount(t, { rows: [], calls });
  assert.match(host.textContent, /No Codex conversations to import/);
  assert.match(host.textContent, /\.codex\\sessions/);
  assert.match(host.textContent, /Choose file…/);
});

test('dialog: nothing selected reads "Import" and a null message count is omitted', async (t) => {
  const host = await mount(t, { rows: [row('a'), row('c')], calls: [] });
  assert.equal(primary(host).textContent, 'Import');
  const meta = [...host.querySelectorAll('.settings-import-item-meta')].map((el) => el.textContent);
  assert.match(meta[0], /12 messages/);
  assert.doesNotMatch(meta[1], /—|·/);
});

test('dialog: a row shows why history is missing without hovering, and not for harmless warnings', async (t) => {
  const rows = [
    { ...row('a'), warnings: ['historySizeLimit', 'cwdMissing'] },
    { ...row('b'), warnings: ['needsNewerNode'] },
    row('c'),
  ];
  const host = await mount(t, { rows, calls: [] });
  const notices = [...host.querySelectorAll('.settings-import-item')].map((item) =>
    [...item.querySelectorAll('.settings-import-item-notice')].map((el) => el.textContent)
  );
  assert.deepEqual(notices, [
    ['Earlier history was left out because it is over the size limit.'],
    ['This conversation is stored compressed. Update Node.js to read it.'],
    [],
  ]);
});

test('dialog: choose file from the empty state pins the returned row and imports it by id', async (t) => {
  const calls = [];
  const picked = { ...row('picked'), title: 'Picked file' };
  const host = await mount(t, {
    rows: [],
    calls,
    api: { chooseConversationImportFile: async () => 'C:\\x\\picked.jsonl' },
    invoke: (capability) => (capability === 'registerConversationImportFile' ? { row: picked } : undefined),
  });
  await click(host.querySelector('.settings-import-secondary'));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
  const items = host.querySelectorAll('.settings-import-item');
  assert.equal(items.length, 1);
  assert.match(items[0].textContent, /Picked file/);
  assert.equal(items[0].querySelector('input').checked, true);
  assert.equal(primary(host).textContent, 'Import and continue');
  await click(primary(host));
  const start = calls.find((call) => call[1] === 'startConversationImport');
  assert.deepEqual(start[2].selection, { ids: ['picked'] });
});

test('dialog: choosing an already-imported file shows a notice and pins nothing', async (t) => {
  const host = await mount(t, {
    rows: [],
    calls: [],
    api: { chooseConversationImportFile: async () => 'C:\\x\\done.jsonl' },
    invoke: (capability) =>
      capability === 'registerConversationImportFile' ? { row: row('done', 'session-1') } : undefined,
  });
  await click(host.querySelector('.settings-import-secondary'));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
  assert.equal(host.querySelectorAll('.settings-import-item').length, 0);
  assert.match(host.querySelector('.settings-import-error').textContent, /This conversation was already imported\./);
});

test('dialog: reopening shows an unacknowledged finished job until dismissed', async (t) => {
  const { importJobStore } = await import('../import-job-store.ts');
  let emit;
  const projects = [];
  window.mixdogDesktop = {
    subscribeConversationImportProgress: (listener) => {
      emit = listener;
      return () => {};
    },
    listProjects: async () => projects,
    addProject: async (path) => projects.push({ path }),
  };
  importJobStore.dispose();
  importJobStore.start();
  emit(
    job({
      state: 'failed',
      errorCode: 'noModelRoute',
      imported: 1,
      byProject: [{ projectPath: 'C:\\Project\\new', imported: 1, skippedAlreadyImported: 0, failed: 0 }],
    })
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(projects, [{ path: 'C:\\Project\\new' }]);
  const host = await mount(t, { rows: [row('a')], calls: [] });
  assert.match(host.textContent, /Imported 1 conversation(?!s)/);
  assert.match(host.textContent, /Connect a model in Settings > Providers first\./);
  await click(host.querySelector('header button'));
  assert.equal(importJobStore.get(), null);
  importJobStore.dispose();
});

test('failure summary groups records by reason and names each by title, else source file', () => {
  const failed = (candidateId, errorCode, extra = {}) => ({
    candidateId,
    status: 'failed',
    errorCode,
    warnings: [],
    ...extra,
  });
  const summary = model.importFailureSummary(
    job({
      failed: 3,
      results: [
        failed('a', 'empty', { title: null, sourceName: 'rollout-a.jsonl' }),
        { candidateId: 'ok', status: 'imported', sessionId: 's', warnings: [] },
        failed('b', 'empty', { title: 'Named thread', sourceName: 'rollout-b.jsonl' }),
        failed('c', 'tooLarge', { title: 'Huge', sourceName: 'rollout-c.jsonl' }),
        failed('d', 'unknownCandidate'),
      ],
    })
  );
  assert.deepEqual(
    summary.map(({ code, count, records }) => [code, count, records.map((record) => record.label)]),
    [
      ['empty', 2, ['rollout-a.jsonl', 'Named thread']],
      ['tooLarge', 1, ['Huge']],
      ['unknownCandidate', 1, ['Untitled session']],
    ]
  );
});

test('failure summary keeps full counts but names only the first records until expanded', () => {
  const results = Array.from({ length: 25 }, (_, index) => ({
    candidateId: `f${index}`,
    status: 'failed',
    errorCode: 'empty',
    warnings: [],
    title: `Thread ${index}`,
  }));
  const folded = model.importFailureSummary(job({ failed: 25, results }));
  assert.deepEqual([folded[0].count, folded[0].records.length], [25, model.IMPORT_FAILURES_SHOWN]);
  const open = model.importFailureSummary(job({ failed: 25, results }), new Set(['empty']));
  assert.deepEqual([open[0].count, open[0].records.length], [25, 25]);
});

test('dialog: a long failure list is folded behind a toggle that shows the rest', async (t) => {
  const { importJobStore } = await import('../import-job-store.ts');
  let emit;
  window.mixdogDesktop = {
    subscribeConversationImportProgress: (listener) => {
      emit = listener;
      return () => {};
    },
    listProjects: async () => [],
    addProject: async () => undefined,
  };
  importJobStore.dispose();
  importJobStore.start();
  emit(
    job({
      state: 'completed',
      total: 25,
      processed: 25,
      failed: 25,
      results: Array.from({ length: 25 }, (_, index) => ({
        candidateId: `f${index}`,
        status: 'failed',
        errorCode: 'empty',
        warnings: [],
        title: `Thread ${index}`,
      })),
    })
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  const host = await mount(t, { rows: [row('a')], calls: [] });
  const items = () => host.querySelectorAll('.settings-import-failed > li').length;
  assert.equal(items(), model.IMPORT_FAILURES_SHOWN);
  assert.match(host.textContent, /The conversation has no messages\. \(25\)/);
  const toggle = host.querySelector('.settings-import-failed-toggle');
  assert.match(toggle.textContent, /\(25\)/);
  await click(toggle);
  assert.equal(items(), 25);
  await click(host.querySelector('.settings-import-failed-toggle'));
  assert.equal(items(), model.IMPORT_FAILURES_SHOWN);
  await click(host.querySelector('header button'));
  importJobStore.dispose();
});

test('dialog: a finished job lists which conversations failed under each reason', async (t) => {
  const { importJobStore } = await import('../import-job-store.ts');
  let emit;
  window.mixdogDesktop = {
    subscribeConversationImportProgress: (listener) => {
      emit = listener;
      return () => {};
    },
    listProjects: async () => [],
    addProject: async () => undefined,
  };
  importJobStore.dispose();
  importJobStore.start();
  emit(
    job({
      state: 'completed',
      total: 3,
      processed: 3,
      imported: 1,
      failed: 2,
      results: [
        { candidateId: 'ok', status: 'imported', sessionId: 's', warnings: [] },
        {
          candidateId: 'a',
          status: 'failed',
          errorCode: 'empty',
          warnings: [],
          title: null,
          sourceName: 'rollout-a.jsonl',
        },
        {
          candidateId: 'b',
          status: 'failed',
          errorCode: 'empty',
          warnings: [],
          title: 'Named thread',
          sourceName: 'rollout-b.jsonl',
        },
      ],
    })
  );
  await new Promise((resolve) => setTimeout(resolve, 10));
  const host = await mount(t, { rows: [row('a')], calls: [] });
  const items = [...host.querySelectorAll('.settings-import-failed > li')].map((item) => item.textContent);
  assert.deepEqual(items, ['rollout-a.jsonl', 'Named thread']);
  assert.match(host.textContent, /The conversation has no messages\. \(2\)/);
  await click(host.querySelector('header button'));
  importJobStore.dispose();
});

test('dialog: a selection made before a query refresh is dropped and cannot be submitted', async (t) => {
  const calls = [];
  let release;
  const page = (viewId) => ({
    searchedRoot: 'C:\\root',
    viewId,
    complete: true,
    matchedCount: 2,
    selectableCount: 2,
    projects: [],
    rows: [row('a'), row('b')],
    nextCursor: null,
  });
  let reads = 0;
  const host = await mount(t, {
    rows: [row('a'), row('b')],
    calls,
    api: {
      readCapabilities: async () => {
        reads += 1;
        if (reads === 1) return [{ ok: true, value: page('view-1') }];
        await new Promise((resolve) => {
          release = resolve;
        });
        return [{ ok: true, value: page('view-2') }];
      },
    },
  });
  await click(host.querySelector('.settings-import-item > input'));
  assert.equal(primary(host).textContent, 'Import and continue');

  const search = host.querySelector('.settings-import-search');
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(search, 'zzz');
    search.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  assert.equal(primary(host).disabled, true);
  assert.equal(primary(host).textContent, 'Import');
  await act(async () => new Promise((resolve) => setTimeout(resolve, 300)));
  // The refresh is in flight: nothing is selected and nothing can be picked or submitted.
  assert.equal(primary(host).disabled, true);
  assert.equal(
    [...host.querySelectorAll('.settings-import-item > input')].every((box) => box.disabled),
    true
  );
  await click(primary(host));
  assert.equal(
    calls.some((call) => call[1] === 'startConversationImport'),
    false
  );
  await act(async () => release());
  assert.equal(host.querySelector('.settings-import-item > input').checked, false);
  assert.equal(host.querySelector('.settings-import-item > input').disabled, false);
});

test('dialog: "Import and continue" is only for exactly one conversation, never a partial select-all', async (t) => {
  const host = await mount(t, { rows: [row('a'), row('b')], calls: [], complete: false });
  const selectAll = host.querySelector('.settings-import-select-all input');
  assert.equal(selectAll.disabled, true);
  const boxes = [...host.querySelectorAll('.settings-import-item > input')];
  await click(boxes[0]);
  assert.equal(primary(host).textContent, 'Import and continue');
  await click(boxes[1]);
  assert.equal(primary(host).textContent, 'Import 2');
});

test('progress view shows the job current title', async (t) => {
  const host = await mount(t, {
    rows: [row('a')],
    calls: [],
    invoke: (capability) =>
      capability === 'getConversationImportJobs'
        ? { jobs: [job({ current: { candidateId: 'a', title: 'Working on this' }, processed: 1 })] }
        : undefined,
  });
  assert.match(host.textContent, /1 \/ 2/);
  assert.match(host.textContent, /Working on this/);
});
