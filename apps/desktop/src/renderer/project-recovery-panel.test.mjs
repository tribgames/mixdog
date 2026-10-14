import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { ProjectRecoveryPanel, recoveryMayRestore } from './ProjectRecoveryPanel.tsx';
import { ProjectRecoverySurface } from './ProjectRecoverySurface.tsx';
import { ProjectRecoveryNotice } from './ProjectRecoveryNotice.tsx';
import { requiredProjectRecoveryRequest, recoveryFailureCode, recoveryFailureRecord } from '../shared/project-recovery.ts';

const id = '12345678-abcd-abcd-abcd-123456789abc';
const revision = 'a'.repeat(64);
const detail = {
  id,
  revision,
  createdAt: 1,
  phase: 'failed',
  fileCount: 2,
  active: false,
  files: [
    { relPath: 'a.txt', status: 'written' },
    { relPath: 'b.txt', status: 'external', reason: 'Changed after the batch' },
  ],
};
const labels = {
  title: 'Recovery',
  refresh: 'Refresh',
  empty: 'No recovery records',
  inspect: 'Inspect',
  openFile: 'Open file',
  restore: 'Restore unchanged files',
  discard: 'Discard record',
  busy: 'Loading',
  observationWarning: 'Observed state; the host rechecks before writing.',
  failure: 'Recovery request failed',
  phases: Object.fromEntries(
    ['interrupted', 'failed', 'recovered', 'completed', 'active', 'invalid', 'retired'].map((x) => [x, x])
  ),
  statuses: Object.fromEntries(
    ['original', 'written', 'restored', 'external', 'missing', 'unavailable'].map((x) => [x, x])
  ),
};
function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function mount(t, overrides = {}, Component = ProjectRecoveryPanel, setup = () => {}) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>');
  const saved = new Map();
  for (const [key, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  }
  const root = createRoot(dom.window.document.getElementById('root'));
  setup(dom.window);
  const calls = [];
  const request = async (project, input) => {
    calls.push([project, input]);
    return input.action === 'list' ? { records: [detail] } : { records: [detail], detail };
  };
  let props = { projectPath: '/project-a', request, confirm: async () => true, openFile() {}, labels, ...overrides };
  t.after(async () => {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  await act(async () => root.render(React.createElement(Component, props)));
  const button = (text) =>
    [...dom.window.document.querySelectorAll('button')].find((node) => node.textContent === text);
  return {
    calls,
    document: dom.window.document,
    button,
    async click(text) {
      assert.ok(button(text), text);
      await act(async () => button(text).click());
    },
    async render(change) {
      props = { ...props, ...change };
      await act(async () => root.render(React.createElement(Component, props)));
    },
  };
}

test('request validator rejects traversal IDs and unapproved mutations', () => {
  for (const input of [
    null,
    [],
    { action: 'inspect', id: '../manifest' },
    { action: 'restore', id },
    { action: 'discard', id, revision: 'stale' },
    { action: 'other', id },
  ]) {
    assert.throws(() => requiredProjectRecoveryRequest(input), TypeError);
  }
  assert.deepEqual(requiredProjectRecoveryRequest({ action: 'list', path: '/ignored' }), { action: 'list' });
  assert.deepEqual(requiredProjectRecoveryRequest({ action: 'restore', id, revision }), {
    action: 'restore',
    id,
    revision,
  });
});

test('restore availability does not treat missing or external files as safe', () => {
  assert.equal(recoveryMayRestore(detail), true);
  for (const phase of ['active', 'invalid', 'completed', 'retired'])
    assert.equal(recoveryMayRestore({ ...detail, phase }), false);
  assert.equal(recoveryMayRestore({ ...detail, active: true }), false);
  for (const status of ['external', 'missing', 'unavailable', 'original', 'restored']) {
    assert.equal(recoveryMayRestore({ ...detail, files: [{ relPath: 'a', status }] }), false);
  }
});

test('inspection displays per-file outcomes and sends the observed revision', async (t) => {
  const ui = await mount(t);
  await ui.click('Inspect');
  assert.match(ui.document.body.textContent, /a.txt.*written/s);
  assert.match(ui.document.body.textContent, /b.txt.*external/s);
  await ui.click('Restore unchanged files');
  assert.deepEqual(ui.calls.at(-1), ['/project-a', { action: 'restore', id, revision }]);
});

test('cancelling confirmation sends no mutation and retains the inspection', async (t) => {
  const ui = await mount(t, { confirm: async () => false });
  await ui.click('Inspect');
  const before = ui.calls.length;
  await ui.click('Discard record');
  assert.equal(ui.calls.length, before);
  assert.ok(ui.button('Restore unchanged files'));
});

test('a failed refresh invalidates the previous approval', async (t) => {
  let fail = false;
  const request = async (_project, input) => {
    if (fail) throw new Error('backend failed');
    return { records: [detail], ...(input.action === 'inspect' ? { detail } : {}) };
  };
  const ui = await mount(t, { request });
  await ui.click('Inspect');
  fail = true;
  await ui.click('Refresh');
  assert.equal(ui.button('Restore unchanged files'), undefined);
  assert.equal(ui.document.querySelector('[role="alert"]').textContent, labels.failure);
});

test('a project change while confirmation is pending never writes to either project', async (t) => {
  const approval = deferred();
  const ui = await mount(t, { confirm: () => approval.promise });
  await ui.click('Inspect');
  await act(async () => ui.button('Restore unchanged files').click());
  await ui.render({ projectPath: '/project-b' });
  await act(async () => approval.resolve(true));
  assert.equal(
    ui.calls.some(([, input]) => input.action === 'restore'),
    false
  );
});

test('an old project list cannot replace the new project list', async (t) => {
  const old = deferred();
  const request = (project) => (project === '/project-a' ? old.promise : Promise.resolve({ records: [] }));
  const ui = await mount(t, { request });
  await ui.render({ projectPath: '/project-b' });
  await act(async () => old.resolve({ records: [detail] }));
  assert.match(ui.document.body.textContent, /No recovery records/);
  assert.equal(ui.button('Inspect'), undefined);
});

test('unmounting while approval is pending cannot send a mutation', async (t) => {
  const approval = deferred();
  const ui = await mount(t, { confirm: () => approval.promise });
  await ui.click('Inspect');
  await act(async () => ui.button('Discard record').click());
  // Changing request identity tears down the previous operation generation,
  // the same cleanup used on component unmount.
  await ui.render({ request: async () => ({ records: [] }) });
  await act(async () => approval.resolve(true));
  assert.equal(
    ui.calls.some(([, input]) => input.action === 'discard'),
    false
  );
});

test('path text is escaped rather than inserted as HTML', async (t) => {
  const hostile = { ...detail, files: [{ relPath: '<img src=x onerror=alert(1)>', status: 'external' }] };
  const ui = await mount(t, {
    request: async (_project, input) => ({
      records: [hostile],
      ...(input.action === 'inspect' ? { detail: hostile } : {}),
    }),
  });
  await ui.click('Inspect');
  assert.equal(ui.document.querySelector('img'), null);
  assert.match(ui.document.body.textContent, /<img src=x/);
  assert.equal(ui.button('Restore unchanged files').disabled, true);
});

for (const phase of ['invalid', 'retired']) {
  test(`${phase} records offer confirmed discard but never restore`, async (t) => {
    const row = { ...detail, phase, files: [], fileCount: 0 };
    const calls = [];
    let confirmations = 0;
    const ui = await mount(t, {
      request: async (_project, input) => {
        calls.push(input);
        return { records: [row], ...(input.action === 'inspect' ? { detail: row } : {}) };
      },
      confirm: async (action) => {
        assert.equal(action, 'discard');
        confirmations++;
        return true;
      },
    });
    await ui.click('Inspect');
    assert.equal(ui.button('Restore unchanged files').disabled, true);
    await ui.click('Discard record');
    assert.equal(confirmations, 1);
    assert.deepEqual(calls.at(-1), { action: 'discard', id, revision });
  });
}

test('the Files recovery surface invokes the host API only after inspection and confirmation', async (t) => {
  const requests = [],
    confirmations = [],
    opened = [];
  const ui = await mount(t, { onOpenFile: (...args) => opened.push(args) }, ProjectRecoverySurface, (window) => {
    window.mixdogDesktop = {
      projectRecovery: async (project, input) => {
        requests.push([project, input]);
        return { records: [detail], ...(input.action === 'inspect' ? { detail } : {}) };
      },
    };
    window.confirm = (text) => {
      confirmations.push(text);
      return true;
    };
  });
  assert.deepEqual(requests, [['/project-a', { action: 'list' }]], 'closed discovery reads metadata only');
  assert.match(ui.document.body.textContent, /need review/);
  assert.equal(ui.button('Restore'), undefined);
  assert.equal(ui.document.querySelector('details').open, false);
  assert.match(ui.document.querySelector('summary').textContent, /File recovery.*1.*Review required/);
  await act(async () => {
    const element = ui.document.querySelector('details');
    element.open = true;
    element.dispatchEvent(new window.Event('toggle'));
  });
  await ui.click('Inspect');
  await ui.click('Open');
  assert.deepEqual(opened, [['/project-a', 'a.txt', 'pinned']]);
  await ui.click('Restore');
  assert.equal(confirmations.length, 1);
  assert.match(confirmations[0], /a\.txt/);
  assert.deepEqual(requests.at(-1), ['/project-a', { action: 'restore', id, revision }]);
});

test('the Files recovery surface stays absent on a host without the API', async (t) => {
  const ui = await mount(t, {}, ProjectRecoverySurface);
  assert.equal(ui.document.querySelector('details'), null);
});


test('stable recovery hints survive IPC wrappers without granting path authority', () => {
  assert.equal(recoveryFailureCode(new Error("Error invoking remote method: RECOVERY_BUSY: wait")), 'RECOVERY_BUSY');
  assert.equal(recoveryFailureCode(new Error('storage full prose')), null);
  assert.equal(recoveryFailureRecord(new Error(`failed\n[file-recovery] ${id}`)), id);
  for (const message of ['failed', '[file-recovery] ../x', `failed\n[file-recovery] ${id}/../x`])
    assert.equal(recoveryFailureRecord(new Error(message)), null);
});

test('a coded mutation failure invalidates approval and gives an actionable reason', async (t) => {
  const ui = await mount(t, {
    labels: { ...labels, failures: { RECOVERY_CHANGED: 'Inspect again before confirming' } },
    request: async (_root, input) => {
      if (input.action === 'restore') throw new Error('IPC: RECOVERY_CHANGED: changed');
      return { records: [detail], ...(input.action === 'inspect' ? { detail } : {}) };
    },
  });
  await ui.click('Inspect');
  await ui.click('Restore unchanged files');
  assert.equal(ui.button('Restore unchanged files'), undefined);
  assert.match(ui.document.querySelector('[role=alert]').textContent, /Inspect again/);
});

test('closed discovery ignores the old project and old host responses', async (t) => {
  const old = deferred();
  const ui = await mount(t, {}, ProjectRecoverySurface, (window) => {
    window.mixdogDesktop = { projectRecovery: (project) => project === '/project-a' ? old.promise : Promise.resolve({ records: [] }) };
  });
  await ui.render({ projectPath: '/project-b' });
  await act(async () => old.resolve({ records: [detail] }));
  assert.equal(ui.document.querySelector('summary').textContent, 'File recovery');
  const oldHost = deferred();
  window.mixdogDesktop = { projectRecovery: () => oldHost.promise };
  await ui.render({});
  window.mixdogDesktop = { projectRecovery: async () => ({ records: [] }) };
  await ui.render({});
  await act(async () => oldHost.resolve({ records: [detail] }));
  assert.equal(ui.document.querySelector('summary').textContent, 'File recovery');
});

test('capacity and missing-folder notices distinguish retained and resolved records', async (t) => {
  const ui = await mount(t, {}, ProjectRecoverySurface, (window) => {
    window.mixdogDesktop = { projectRecovery: async () => ({
      records: [detail], rootAvailable: false,
      storage: { usedRecords: 20, maxRecords: 20, unresolvedRecords: 18, resolvedRecords: 2,
        payloadBytes: 1048576, unknownSizeRecords: 1, maxBatchBytes: 16777216, maxBatchFiles: 100 },
    }) };
  });
  await act(async () => {
    const element = ui.document.querySelector('details');
    element.open = true;
    element.dispatchEvent(new window.Event('toggle'));
  });
  assert.match(ui.document.body.textContent, /20 \/ 20.*Need review: 18.*Resolved: 2/s);
  assert.match(ui.document.body.textContent, /Recorded payload: 1.00 MiB/);
  assert.match(ui.document.body.textContent, /Unknown-size records: 1/);
  assert.match(ui.document.body.textContent, /storage is full/);
  assert.match(ui.document.body.textContent, /folder is missing or unavailable/);
});

test('batch failure affordance opens the exact record only after a user click', async (t) => {
  const calls = [];
  const ui = await mount(t, { message: `batch failed\n[file-recovery] ${id}`, onOpenFile() {} }, ProjectRecoveryNotice, (window) => {
    window.mixdogDesktop = { projectRecovery: async (project, input) => {
      calls.push([project, input]);
      return { records: [detail], ...(input.action === 'inspect' ? { detail } : {}) };
    } };
  });
  assert.equal(calls.length, 0);
  await ui.click('Inspect file recovery');
  assert.ok(calls.some(([, input]) => input.action === 'inspect' && input.id === id));
  assert.equal(calls.some(([, input]) => ['discard', 'restore'].includes(input.action)), false);
});

test('focus refresh failure never reports zero records as a successful inventory', async (t) => {
  let failed = false;
  const ui = await mount(t, {}, ProjectRecoverySurface, (window) => {
    window.mixdogDesktop = { projectRecovery: async () => {
      if (failed) throw new Error('offline');
      return { records: [detail] };
    } };
  });
  assert.match(ui.document.querySelector('summary').textContent, /1/);
  failed = true;
  await act(async () => window.dispatchEvent(new window.Event('focus')));
  assert.equal(ui.document.querySelector('details').open, false);
  assert.match(ui.document.querySelector('summary').textContent, /Unavailable/);
  assert.match(ui.document.body.textContent, /Recovery request failed/);
  assert.doesNotMatch(ui.document.body.textContent, /No file recovery records/);
});

for (const source of ['focus', 'folder']) {
  test(`open recovery ${source} refresh replaces the visible list and invalidates inspection`, async (t) => {
    let records = [detail], folderChanged;
    const ui = await mount(t, { initiallyOpen: true }, ProjectRecoverySurface, (window) => {
      window.mixdogDesktop = {
        projectRecovery: async (_project, input) => ({ records, ...(input.action === 'inspect' ? { detail } : {}) }),
        subscribeFolderChanges: (callback) => { folderChanged = callback; return () => {}; },
      };
    });
    await ui.click('Inspect');
    assert.ok(ui.button('Restore'));
    records = [{ ...detail, id: '22345678-abcd-abcd-abcd-123456789abc' }, { ...detail, id: '32345678-abcd-abcd-abcd-123456789abc' }];
    if (source === 'folder') t.mock.timers.enable({ apis: ['setTimeout'] });
    await act(async () => {
      if (source === 'focus') window.dispatchEvent(new window.Event('focus'));
      else { folderChanged('/project-a'); t.mock.timers.tick(250); }
    });
    assert.equal(ui.button('Restore'), undefined);
    assert.equal([...ui.document.querySelectorAll('button')].filter((b) => b.textContent === 'Inspect').length, 2);
    assert.match(ui.document.querySelector('summary').textContent, /2/);
  });
}

test('an unavailable automatic refresh clears open controls and permits an explicit retry', async (t) => {
  let failed = false;
  const ui = await mount(t, { initiallyOpen: true }, ProjectRecoverySurface, (window) => {
    window.mixdogDesktop = { projectRecovery: async (_project, input) => {
      if (failed) throw new Error('RECOVERY_MANUAL_INSPECTION: unknown entry');
      return { records: [detail], ...(input.action === 'inspect' ? { detail } : {}) };
    } };
  });
  await ui.click('Inspect');
  failed = true;
  await act(async () => window.dispatchEvent(new window.Event('focus')));
  assert.equal(ui.button('Restore'), undefined);
  assert.equal(ui.button('Delete'), undefined);
  assert.match(ui.document.body.textContent, /manually/);
  failed = false;
  await ui.click('Refresh');
  assert.ok(ui.button('Inspect'));
  assert.equal(ui.button('Restore'), undefined);
});

test('an inspect response preceding automatic discovery cannot revive an old approval', async (t) => {
  const old = deferred();
  let records = [detail];
  const ui = await mount(t, { initiallyOpen: true }, ProjectRecoverySurface, (window) => {
    window.mixdogDesktop = { projectRecovery: async (_project, input) =>
      input.action === 'inspect' ? old.promise : { records } };
  });
  await ui.click('Inspect');
  records = [];
  await act(async () => window.dispatchEvent(new window.Event('focus')));
  await act(async () => old.resolve({ records: [detail], detail }));
  assert.equal(ui.button('Restore'), undefined);
  assert.equal(ui.button('Inspect'), undefined);
  assert.match(ui.document.body.textContent, /No file recovery records/);
});

test('automatic refresh does not reopen an initial record after explicit discard', async (t) => {
  let records = [detail];
  const requests = [];
  const ui = await mount(t, { initialRecordId: id }, ProjectRecoverySurface, (window) => {
    window.confirm = () => true;
    window.mixdogDesktop = { projectRecovery: async (_project, input) => {
      requests.push(input);
      if (input.action === 'discard') records = [];
      if (input.action === 'inspect' && !records.length) throw new Error('RECOVERY_UNAVAILABLE: discarded');
      return { records, ...(input.action === 'inspect' ? { detail } : {}) };
    } };
  });
  assert.ok(ui.button('Delete'));
  await ui.click('Delete');
  await act(async () => window.dispatchEvent(new window.Event('focus')));
  assert.equal(requests.filter((input) => input.action === 'inspect').length, 1);
  assert.match(ui.document.body.textContent, /No file recovery records/);
  assert.doesNotMatch(ui.document.querySelector('summary').textContent, /Unavailable/);
});
