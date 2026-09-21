// Prompt-submit dispatcher contract for daemon-backed settings writes.
//
// Two properties are pinned here because both lose user input when they break:
//   1. one write per surface at a time (a fast second Enter must be refused,
//      never started as an overlapping write), and
//   2. an ack that no longer owns the surface (superseded by Esc or by a newer
//      submit) must not close the prompt, navigate, or claim success.
// Plus the documented clear-by-empty settings actions must reach the daemon.
import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as flush } from 'node:timers/promises';

import { createPromptSubmit } from './prompt-submit.mjs';
import { supersedePanelEpoch } from './panel-epoch.mjs';
import { canSubmitTextEntry, textEntryClearsByEmpty } from './text-entry-policy.mjs';

function createHarness({ settingsPrompt = null, store: storeOverrides = {} } = {}) {
  const notices = [];
  const settingsPromptSet = [];
  const opened = [];
  const store = {
    pushNotice: (message, tone) => notices.push([message, tone]),
    ...storeOverrides,
  };
  const { onSubmit } = createPromptSubmit({
    store,
    state: { commandBusy: false },
    providerPrompt: null,
    settingsPrompt,
    setProviderPrompt: () => {},
    setSettingsPrompt: (next) => {
      settingsPromptSet.push(typeof next === 'function' ? next(settingsPrompt) : next);
    },
    oauthSubmitRef: { current: false },
    clearModelCaches: () => {},
    openProviderSetupPicker: () => {
      opened.push('providers');
    },
    openSettingsPicker: () => {
      opened.push('settings');
    },
    openProjectPicker: () => {
      opened.push('projects');
    },
    openAutoClearPicker: () => {
      opened.push('autoclear');
    },
    openProfilePicker: () => {
      opened.push('profile');
    },
    openPluginsPicker: () => {},
    openMcpServersPicker: () => {},
    openProjectSkillsPicker: () => {},
    openMemoryCorePicker: () => {},
    registerProject: () => {},
    runSlashCommand: () => true,
    armTranscriptFollow: () => {},
    clearPastedImagesSnapshot: () => {},
    clearPastedTextsSnapshot: () => {},
    pastedImagesRef: { current: {} },
    pastedTextsRef: { current: {} },
  });
  return { onSubmit, notices, settingsPromptSet, opened };
}

const closedCount = (harness) => harness.settingsPromptSet.filter((value) => value === null).length;

test('a second settings submit is refused while the first daemon write is in flight', async () => {
  supersedePanelEpoch();
  const gate = Promise.withResolvers();
  const shellCalls = [];
  const harness = createHarness({
    settingsPrompt: { kind: 'system-shell', label: 'System shell' },
    store: {
      setSystemShell: (command) => {
        shellCalls.push(command);
        return gate.promise;
      },
    },
  });

  assert.equal(harness.onSubmit('pwsh'), true);
  // Fast second Enter (before React re-renders the prompt): refused, so the
  // draft is kept and no overlapping write is started.
  assert.equal(harness.onSubmit('bash'), false);
  assert.deepEqual(shellCalls, ['pwsh']);
  assert.ok(harness.notices.some(([message, tone]) => tone === 'warn' && /settings change/.test(message)));

  gate.resolve(true);
  await flush();
  assert.equal(closedCount(harness), 1);
  assert.deepEqual(harness.opened, ['settings']);
});

test('an ack superseded by Esc and a newer submit never closes the live prompt', async () => {
  supersedePanelEpoch();
  const first = Promise.withResolvers();
  const second = Promise.withResolvers();

  const firstHarness = createHarness({
    settingsPrompt: { kind: 'system-shell', label: 'System shell' },
    store: { setSystemShell: () => first.promise },
  });
  assert.equal(firstHarness.onSubmit('pwsh'), true);

  // Esc on the prompt (cancelSettingsPrompt) hands the surface back.
  supersedePanelEpoch();

  // A fresh prompt + submit: the abandoned write must not block it.
  const secondHarness = createHarness({
    settingsPrompt: { kind: 'system-shell', label: 'System shell' },
    store: { setSystemShell: () => second.promise },
  });
  assert.equal(secondHarness.onSubmit('bash'), true);

  first.resolve(true);
  await flush();
  // The older ack owns nothing: no close, no navigation, no success claim.
  assert.equal(closedCount(firstHarness), 0);
  assert.deepEqual(firstHarness.opened, []);

  second.resolve(true);
  await flush();
  assert.equal(closedCount(secondHarness), 1);
  assert.deepEqual(secondHarness.opened, ['settings']);
});

test('a rejected settings write restores the typed value instead of closing', async () => {
  supersedePanelEpoch();
  const gate = Promise.withResolvers();
  const harness = createHarness({
    settingsPrompt: { kind: 'system-shell', label: 'System shell' },
    store: { setSystemShell: () => gate.promise },
  });
  assert.equal(harness.onSubmit('pwsh -NoLogo'), true);

  gate.reject(new Error('daemon offline'));
  await flush();

  assert.equal(closedCount(harness), 0);
  const restored = harness.settingsPromptSet[harness.settingsPromptSet.length - 1];
  assert.equal(restored.kind, 'system-shell');
  assert.equal(restored.initialValue, 'pwsh -NoLogo');
  assert.equal(restored.submitting, false);
  assert.ok(restored.restoreEpoch >= 1);
  assert.ok(harness.notices.some(([message, tone]) => tone === 'error' && /daemon offline/.test(message)));
});

test('empty submits reach the daemon as the documented reset/clear actions', async () => {
  supersedePanelEpoch();
  const shellCalls = [];
  const shell = createHarness({
    settingsPrompt: { kind: 'system-shell', label: 'System shell' },
    store: {
      setSystemShell: (command) => {
        shellCalls.push(command);
        return Promise.resolve(true);
      },
    },
  });
  assert.equal(shell.onSubmit(''), true);
  await flush();
  assert.deepEqual(shellCalls, ['']);
  assert.equal(closedCount(shell), 1);

  supersedePanelEpoch();
  const autoClearCalls = [];
  const autoClear = createHarness({
    settingsPrompt: { kind: 'autoclear-provider', label: 'Auto-clear · openai', provider: 'openai' },
    store: {
      setAutoClear: (patch) => {
        autoClearCalls.push(patch);
        return Promise.resolve({ enabled: true });
      },
    },
  });
  assert.equal(autoClear.onSubmit(''), true);
  await flush();
  assert.deepEqual(autoClearCalls, [{ provider: 'openai', resetProvider: true }]);
  assert.ok(autoClear.notices.some(([message]) => /default reset/.test(message)));

  supersedePanelEpoch();
  const profileCalls = [];
  const profile = createHarness({
    settingsPrompt: { kind: 'profile-title', label: 'Profile · Title' },
    store: {
      setProfile: (patch) => {
        profileCalls.push(patch);
        return Promise.resolve({ title: '' });
      },
    },
  });
  assert.equal(profile.onSubmit(''), true);
  await flush();
  assert.deepEqual(profileCalls, [{ title: '' }]);
  assert.ok(profile.notices.some(([message]) => /Title cleared/.test(message)));
});

test('clear-by-empty prompt kinds bypass the blank-submit gate', () => {
  assert.equal(textEntryClearsByEmpty('system-shell'), true);
  assert.equal(textEntryClearsByEmpty('autoclear-provider'), true);
  assert.equal(textEntryClearsByEmpty('profile-title'), true);
  assert.equal(textEntryClearsByEmpty('core-add'), false);
  assert.equal(textEntryClearsByEmpty(''), false);
  assert.equal(canSubmitTextEntry('', true), true);
  assert.equal(canSubmitTextEntry('   ', true), true);
  assert.equal(canSubmitTextEntry('', false), false);
  assert.equal(canSubmitTextEntry(' value ', false), true);
});
