import assert from 'node:assert/strict';
import test from 'node:test';

import {
  requiredDesktopCapabilityRequest,
  requiredVisualizeGestureTarget,
  requiredVisualizeTabCommand,
} from './ipc-validation.ts';

const ids = { sessionId: 'session-1', tabId: 'tab-1' };
const cmd = (extra) => requiredVisualizeTabCommand({ ...ids, ...extra });

test('visualize export accepts formats and optional pane, rejects the rest', () => {
  assert.deepEqual(cmd({ action: 'export', format: 'png' }), { ...ids, action: 'export', format: 'png' });
  assert.deepEqual(cmd({ action: 'export', format: 'pdf', pane: 15 }), {
    ...ids,
    action: 'export',
    format: 'pdf',
    pane: 15,
  });
  assert.equal(cmd({ action: 'export', format: 'project', pane: 0 }).pane, 0);
  for (const bad of [
    { format: 'gif' },
    { format: 'png', pane: 16 },
    { format: 'png', pane: -1 },
    { format: 'png', pane: 1.5 },
    { format: 'png', pane: '1' },
    { format: 'png', pane: null },
  ]) {
    assert.throws(() => cmd({ action: 'export', ...bad }), TypeError);
  }
});

test('visualize reopen validates targets, content and label', () => {
  assert.deepEqual(cmd({ action: 'reopen', targets: ['a.html'], label: 'L' }), {
    ...ids,
    action: 'reopen',
    targets: ['a.html'],
    label: 'L',
  });
  assert.deepEqual(cmd({ action: 'reopen', targets: ['a', 'b', 'c'], label: '' }), {
    ...ids,
    action: 'reopen',
    targets: ['a', 'b', 'c'],
  });
  for (const bad of [
    { targets: [] },
    { targets: ['a', 'b', 'c', 'd'] },
    { targets: ['https://x.test/a'] },
    { targets: ['  '] },
    { targets: ['a'.repeat(4097)] },
    { targets: [1] },
    { targets: 'a' },
    { targets: ['a'], label: 'x'.repeat(121) },
    { targets: ['a'], label: 5 },
  ]) {
    assert.throws(() => cmd({ action: 'reopen', ...bad }), TypeError);
  }
  const content = { kind: 'html', source: '<p>x</p>', title: 'T' };
  const ok = cmd({ action: 'reopen', content, label: 'L' });
  assert.deepEqual(ok, { ...ids, action: 'reopen', targets: [], content, label: 'L' });
  assert.deepEqual(cmd({ action: 'reopen', content: { kind: 'html', source: '', title: '' } }).content, {
    kind: 'html',
    source: '',
  });
  for (const bad of [
    { kind: 'nope', source: 's' },
    { kind: 'html', source: 5 },
    { kind: 'html', source: 's', title: 'x'.repeat(121) },
    { kind: 'html', source: 's', title: 3 },
    null,
  ]) {
    assert.throws(() => cmd({ action: 'reopen', content: bad }), TypeError);
  }
  assert.throws(() => cmd({ action: 'reopen', content, label: 'x'.repeat(121) }), TypeError);
});

test('visualize version, render and restore validation', () => {
  assert.deepEqual(cmd({ action: 'version', version: null }), { ...ids, action: 'version', version: null });
  assert.deepEqual(cmd({ action: 'version', version: 3, compare: true }), {
    ...ids,
    action: 'version',
    version: 3,
    compare: true,
  });
  assert.deepEqual(cmd({ action: 'version', version: 3, compare: false }), { ...ids, action: 'version', version: 3 });
  for (const bad of [
    { version: 0 },
    { version: 1.5 },
    { version: '1' },
    { version: 1_000_000_001 },
    { version: 1, compare: 'y' },
  ]) {
    assert.throws(() => cmd({ action: 'version', ...bad }), TypeError);
  }
  assert.deepEqual(cmd({ action: 'render', pane: 2, renderId: 'r' }), {
    ...ids,
    action: 'render',
    pane: 2,
    renderId: 'r',
  });
  assert.equal(cmd({ action: 'render', pane: 2, renderId: 'r', error: 'e'.repeat(5000) }).error.length, 4000);
  assert.equal('error' in cmd({ action: 'render', pane: 2, renderId: 'r', error: '' }), false);
  for (const bad of [
    { pane: 16, renderId: 'r' },
    { pane: 'a', renderId: 'r' },
    { pane: 1 },
    { pane: 1, renderId: 'r'.repeat(129) },
    { pane: 1, renderId: 'r', error: 7 },
  ]) {
    assert.throws(() => cmd({ action: 'render', ...bad }), TypeError);
  }
  assert.deepEqual(cmd({ action: 'restore', version: 2, assets: ['a'] }), {
    ...ids,
    action: 'restore',
    version: 2,
    assets: ['a'],
  });
  assert.deepEqual(cmd({ action: 'restore', version: 2, assets: [] }), { ...ids, action: 'restore', version: 2 });
  for (const bad of [
    { version: 2, assets: 'a' },
    { version: 2, assets: [''] },
    { version: 2, assets: [1] },
    { version: 2, assets: Array(65).fill('a') },
    {},
  ]) {
    assert.throws(() => cmd({ action: 'restore', ...bad }), TypeError);
  }
});

test('visualize blocked-network report from a remote page frame', () => {
  const report = { action: 'blocked', pane: 1, url: 'https://cdn.example/a.js', resource: 'script' };
  assert.deepEqual(cmd({ ...report, extra: 1 }), { ...ids, ...report });
  for (const bad of [{ pane: 16 }, { url: '' }, { url: 'x'.repeat(2049) }, { resource: 'a b' }, { resource: 7 }]) {
    assert.throws(() => cmd({ ...report, ...bad }), TypeError);
  }
});

test('visualize network, history, simple actions and gesture target', () => {
  assert.deepEqual(cmd({ action: 'network', allow: true }), { ...ids, action: 'network', allow: true });
  assert.throws(() => cmd({ action: 'network', allow: 1 }), TypeError);
  assert.deepEqual(cmd({ action: 'activate' }), { ...ids, action: 'activate' });
  assert.deepEqual(cmd({ action: 'close' }), { ...ids, action: 'close' });
  assert.throws(() => cmd({ action: 'bogus' }), TypeError);
  assert.deepEqual(requiredVisualizeTabCommand({ sessionId: 'session-1', action: 'history', entry: 'e' }), {
    sessionId: 'session-1',
    tabId: '',
    action: 'history',
    entry: 'e',
  });
  assert.deepEqual(requiredVisualizeGestureTarget({ ...ids, pane: 15 }), { ...ids, pane: 15 });
  for (const pane of [16, -1, 1.5, '1', undefined]) {
    assert.throws(() => requiredVisualizeGestureTarget({ ...ids, pane }), TypeError);
  }
});

const cap = (capability, ...args) => requiredDesktopCapabilityRequest({ capability, args });

test('capability argument groups keep their accept/reject behavior', () => {
  assert.throws(() => cap('contextStatus', null), TypeError);
  assert.throws(() => cap('contextStatus', { inspect: false }), TypeError);
  assert.throws(() => cap('contextStatus', { inspect: true, revision: 'r' }), TypeError);
  assert.throws(() => cap('contextStatus', { inspect: true, entryId: 'e' }), TypeError);
  assert.doesNotThrow(() => cap('contextStatus', { inspect: true, entryId: 'e', revision: 'r' }));
  assert.throws(() => cap('setInstructionFiles', 'x'), TypeError);
  assert.doesNotThrow(() => cap('setInstructionFiles', 'agents'));
  assert.throws(() => cap('setAutoEffortBase', 'max'), TypeError);
  assert.doesNotThrow(() => cap('setAutoEffortBase', 'high'));
  assert.throws(() => cap('setBuiltinToolEnabled', 'nope', true), TypeError);
  assert.doesNotThrow(() => cap('setBuiltinToolEnabled', 'git', true));
  assert.throws(() => cap('installBuiltinFeature', 'nope'), TypeError);
  assert.throws(() => cap('startLocalProviderInstallation', 'runtime', 'm'), TypeError);
  assert.throws(() => cap('startLocalProviderInstallation', 'model'), TypeError);
  assert.doesNotThrow(() => cap('startLocalProviderInstallation', 'model', 'm'));
  assert.throws(() => cap('discardLocalProviderInstallation', 'bogus'), TypeError);
  assert.throws(() => cap('setLocalProviderContext', 'm', 100), TypeError);
  assert.doesNotThrow(() => cap('setLocalProviderContext', 'm', null));
  assert.throws(() => cap('setLocalProviderIdleTtl', 86401), TypeError);
  assert.doesNotThrow(() => cap('setLocalProviderIdleTtl', 0));
  assert.throws(() => cap('saveProviderApiKey', 'p', '  '), TypeError);
  assert.doesNotThrow(() => cap('saveProviderApiKey', 'p', 'key'));
  assert.throws(() => cap('saveProviderApiKey', 'openai', 'key', { location: 'global' }), TypeError);
  assert.doesNotThrow(() =>
    cap('saveProviderApiKey', 'vertex-ai', '{"type":"service_account"}', {
      location: 'us-east5',
      projectId: 'override-project',
    })
  );
  assert.throws(() => cap('saveProviderApiKey', 'vertex-ai', 'key', { location: '../bad' }), TypeError);
  assert.throws(() => cap('saveProviderApiKey', 'vertex-ai', 'key', { location: 'global', projectId: 'bad/project' }), TypeError);
  assert.throws(() => cap('saveOpenAIUsageSessionKey', ''), TypeError);
  assert.throws(() => cap('getTurnReviewDiff', { poll: 'foreground' }), TypeError);
  assert.throws(() => cap('getTurnReviewDiff', { known: 'xyz' }), TypeError);
  assert.doesNotThrow(() => cap('getTurnReviewDiff', { refresh: true, poll: 'background', known: 'a'.repeat(32) }));
  assert.throws(() => cap('getTurnChanges', []), TypeError);
  assert.throws(() => cap('getTurnChanges', { checkpointId: 'c', other: 1 }), TypeError);
  assert.doesNotThrow(() => cap('getTurnChanges', { checkpointId: 'c', patch: true, file: 'f' }));
  assert.throws(() => cap('revertTurnChanges', 'c', null, -1), TypeError);
  assert.doesNotThrow(() => cap('reapplyTurnChanges', 'c', null, 0));
  assert.throws(() => cap('getProviderSetup', { unknown: true }), TypeError);
  assert.throws(() => cap('getProviderSetup', []), TypeError);
  assert.throws(() => cap('skillsStatus', []), TypeError);
  assert.throws(() => cap('skillsStatus', { projectPath: 'relative/path' }), TypeError);
  assert.throws(() => cap('skillsStatus', { projectPath: '/abs\0x' }), TypeError);
});
