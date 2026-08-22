// Panel-ownership (epoch) regression suite.
//
// Two resurrection paths are pinned here, both reproduced in review:
//   1. a settings chain whose ASYNC PREFLIGHT (listOutputStyles/listWorkflows)
//      settles after Esc — the epoch must belong to the KEYPRESS, not to the
//      ack, or the post-write refresh re-opens Settings over whatever surface
//      the user is looking at now;
//   2. an object → object panel replacement — opening a different panel over
//      Settings must supersede, or a deferred Settings refresh clobbers it.
// App.jsx cannot be imported here (no JSX parser in this workspace), so its
// handover rule is exercised through the shared helper it delegates to, plus a
// source-text pin on the one call site.
//
// The class rule is no longer audited by pattern matching: panel-surface.mjs
// owns the sinks, so the two structural tests at the bottom are the whole
// enforcement — the sinks are unreachable outside the owning layer, and a claim
// rejects every late-paint shape that used to defeat the analyzer.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { basename, join, relative } from 'node:path';

import {
  panelIdentity,
  shouldSupersedePanelEpoch,
  supersedePanelEpoch,
} from './panel-epoch.mjs';
import { createPanelSurface } from './panel-surface.mjs';
import { createSettingsPicker } from './settings-picker.mjs';
import { createMaintenancePickers } from './maintenance-pickers.mjs';
import { createExtensionPickers } from './extension-pickers.mjs';
import { createModelPicker } from './model-picker.mjs';
import { createOnboardingSteps } from './onboarding-steps.mjs';
import { createProviderSetupPicker } from './provider-setup-picker.mjs';
import { createRoutePickers } from './route-pickers.mjs';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// Drain BOTH phases repeatedly: these chains hop through timers (setTimeout 0)
// as well as microtasks, and a too-short drain lets a probe pass vacuously
// because the branch under test had not run yet.
const flush = async (rounds = 12) => {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setImmediate(resolve));
  }
};

// Mirrors the ownership rule of App.jsx (src/tui/App.jsx:349-368): the live ref
// is updated synchronously and a handover bumps the epoch. The host plays the
// owning layer — it holds the raw sink and hands the panel modules a surface.
function createPanelHost() {
  let live = null;
  const painted = [];
  const setPicker = (next) => {
    const previous = live;
    live = typeof next === 'function' ? next(previous) : next;
    if (shouldSupersedePanelEpoch(previous, live)) supersedePanelEpoch();
    painted.push(live);
  };
  const surface = createPanelSurface({
    setPicker,
    setContextPanel: () => {},
    setUsagePanel: () => {},
  });
  return { setPicker, surface, painted, current: () => live };
}

function createSettingsHarness({ store: storeOverrides = {}, host = null } = {}) {
  const painted = [];
  const notices = [];
  const store = {
    pushNotice: (message, tone) => notices.push([message, tone]),
    getSettingsSnapshot: async () => ({}),
    ...storeOverrides,
  };
  const noop = () => {};
  const { openSettingsPicker } = createSettingsPicker({
    store,
    state: { model: 'gpt-5', provider: 'openai', workflow: { id: 'default' } },
    surface: createPanelSurface({
      setPicker: (next) => {
        painted.push(next);
        if (host) host.setPicker(next);
      },
        setUsagePanel: noop,
    }),
    setProviderPrompt: noop,
    setSettingsPrompt: noop,
    settingsHeavyCacheRef: { current: null },
    settingsRequestRef: { current: 0 },
    formatDuration: (ms) => `${ms}ms`,
    displayModelName: () => 'gpt-5',
    routeModelLabel: () => '(unset)',
    workflowDisplayName: () => 'Default',
    workflowSwitchNotice: () => 'workflow switched',
    themeNotice: () => 'theme set',
    openModelPicker: noop,
    openWebSearchPicker: noop,
    openAgentsPicker: noop,
    openWorkflowPicker: noop,
    openOutputStylePicker: noop,
    openProviderSetupPicker: noop,
    openThemePicker: noop,
    openAutoClearPicker: noop,
    openProfilePicker: noop,
    openMcpPicker: noop,
    openPluginsPicker: noop,
    openHooksPicker: noop,
    openSkillsPicker: noop,
    openMemoryCorePicker: noop,
    openUpdatePicker: noop,
  });
  return { openSettingsPicker, painted, notices };
}

const lastPanel = (painted) => painted[painted.length - 1];

test('panel handover: close and replacement supersede, rebuild and first open do not', () => {
  const settings = { title: 'Settings' };
  assert.equal(panelIdentity(settings), 'Settings');
  assert.equal(panelIdentity({ _kind: 'mcp-servers', title: 'MCP servers · 2 connected' }), 'mcp-servers');
  assert.equal(panelIdentity(null), null);

  // Close: the reviewed case.
  assert.equal(shouldSupersedePanelEpoch(settings, null), true);
  // Replacement by a DIFFERENT panel: the gap this suite closes.
  assert.equal(shouldSupersedePanelEpoch(settings, { title: 'Core memories' }), true);
  assert.equal(shouldSupersedePanelEpoch({ _kind: 'hooks', title: 'Hooks' }, { _kind: 'skills', title: 'Hooks' }), true);
  // Rebuild of the same surface (light refresh / toggle re-render): keeps
  // ownership so its own deferred refresh still lands.
  assert.equal(shouldSupersedePanelEpoch(settings, { title: 'Settings', items: [] }), false);
  assert.equal(shouldSupersedePanelEpoch(settings, settings), false);
  assert.equal(shouldSupersedePanelEpoch({ _kind: 'mcp-servers', title: 'MCP · 1' }, { _kind: 'mcp-servers', title: 'MCP · 2' }), false);
  // Nothing owned the surface: null → null and the first open are not handovers
  // (an in-flight text-entry prompt write must stay valid).
  assert.equal(shouldSupersedePanelEpoch(null, null), false);
  assert.equal(shouldSupersedePanelEpoch(null, settings), false);
});

test('an output-style cycle whose preflight resolves after Esc does not re-open Settings', async () => {
  supersedePanelEpoch();
  const listGate = deferred();
  const styleWrites = [];
  const harness = createSettingsHarness({
    store: {
      listOutputStyles: () => listGate.promise,
      setOutputStyle: (id) => {
        styleWrites.push(id);
        return Promise.resolve({ current: { id, label: id } });
      },
    },
  });
  await harness.openSettingsPicker();
  const panel = lastPanel(harness.painted);
  assert.ok(panel, `settings panel never painted: ${JSON.stringify(harness.notices)}`);
  assert.equal(panel.title, 'Settings');
  const paintedBefore = harness.painted.length;

  // Keypress: the epoch must be captured HERE, before the listOutputStyles
  // round-trip below.
  panel.onRight({ _action: 'output-style' });
  // Esc — the user is now looking at something else.
  supersedePanelEpoch();
  listGate.resolve({ styles: [{ id: 'default' }, { id: 'concise' }], current: { id: 'default' } });
  await flush();

  // The write still runs (the user asked for it); only the paint is dropped.
  assert.deepEqual(styleWrites, ['concise']);
  assert.equal(harness.painted.length, paintedBefore);
});

test('a workflow cycle whose preflight resolves after Esc does not re-open Settings', async () => {
  supersedePanelEpoch();
  const listGate = deferred();
  const workflowWrites = [];
  const harness = createSettingsHarness({
    store: {
      listWorkflows: () => listGate.promise,
      setWorkflow: (id) => {
        workflowWrites.push(id);
        return Promise.resolve({ id });
      },
    },
  });
  await harness.openSettingsPicker();
  const panel = lastPanel(harness.painted);
  const paintedBefore = harness.painted.length;

  panel.onRight({ _action: 'workflow' });
  supersedePanelEpoch();
  listGate.resolve([{ id: 'default', active: true }, { id: 'ship' }]);
  await flush();

  assert.deepEqual(workflowWrites, ['ship']);
  assert.equal(harness.painted.length, paintedBefore);
});

test('an undisturbed output-style cycle still refreshes Settings', async () => {
  supersedePanelEpoch();
  const listGate = deferred();
  const harness = createSettingsHarness({
    store: {
      listOutputStyles: () => listGate.promise,
      setOutputStyle: (id) => Promise.resolve({ current: { id, label: id } }),
    },
  });
  await harness.openSettingsPicker();
  const paintedBefore = harness.painted.length;

  lastPanel(harness.painted).onRight({ _action: 'output-style' });
  listGate.resolve({ styles: [{ id: 'default' }, { id: 'concise' }], current: { id: 'default' } });
  await flush();

  assert.ok(harness.painted.length > paintedBefore);
  assert.equal(lastPanel(harness.painted).title, 'Settings');
});

test('a deferred Settings refresh cannot clobber the panel that replaced Settings', async () => {
  supersedePanelEpoch();
  const writeGate = deferred();
  const host = createPanelHost();
  const harness = createSettingsHarness({
    host,
    store: { setRecapEnabled: () => writeGate.promise },
  });
  await harness.openSettingsPicker();
  assert.equal(host.current().title, 'Settings');

  // Toggle a row: the refresh epoch is captured on this keypress.
  lastPanel(harness.painted).onRight({ _action: 'memory-cycles' });
  // The user opens a nested panel over Settings (object → object).
  host.setPicker({ title: 'Core memories' });
  const paintedBefore = host.painted.length;

  writeGate.resolve(true);
  await flush();

  assert.equal(host.current().title, 'Core memories');
  assert.equal(host.painted.length, paintedBefore);
});

test('a Settings rebuild keeps ownership, so its own deferred refresh still lands', async () => {
  supersedePanelEpoch();
  const writeGate = deferred();
  const host = createPanelHost();
  const harness = createSettingsHarness({
    host,
    store: { setRecapEnabled: () => writeGate.promise },
  });
  await harness.openSettingsPicker();

  lastPanel(harness.painted).onRight({ _action: 'memory-cycles' });
  // Same surface, rebuilt (a light refresh from another chain): not a handover.
  host.setPicker({ title: 'Settings', items: [] });
  const paintedBefore = host.painted.length;

  writeGate.resolve(true);
  await flush();

  assert.ok(host.painted.length > paintedBefore);
  assert.equal(host.current().title, 'Settings');
});

function createUpdateHarness(host, checkGate) {
  const notices = [];
  const store = {
    pushNotice: (message, tone) => notices.push([message, tone]),
    getUpdateSettings: async () => ({ currentVersion: '0.9.147', autoUpdate: false }),
    getUpdateStatus: async () => ({ phase: 'idle' }),
    checkForUpdate: () => checkGate.promise,
  };
  const noop = () => {};
  const { openUpdatePicker } = createMaintenancePickers({
    store,
    theme: {},
    formatDuration: (ms) => `${ms}ms`,
    surface: host.surface,
    setProviderPrompt: noop,
    setSettingsPrompt: noop,
    closeUsagePanel: noop,
  });
  return { openUpdatePicker, notices };
}

test('the Update panel repaints its first check across the Settings → Update handover', async () => {
  supersedePanelEpoch();
  const host = createPanelHost();
  host.setPicker({ title: 'Settings' });
  const checkGate = deferred();
  const { openUpdatePicker } = createUpdateHarness(host, checkGate);

  openUpdatePicker({});
  await flush();
  assert.equal(host.current().title, 'Update');
  const paintedBefore = host.painted.length;

  checkGate.resolve({ latestVersion: '0.9.148' });
  await flush();

  // The open transition supersedes the previous owner's deferred paints, but
  // the panel's own initial check (captured after it took the surface) lands.
  assert.ok(host.painted.length > paintedBefore);
  assert.equal(host.current().title, 'Update');
});

test('Esc on the Update panel still kills its in-flight first check', async () => {
  supersedePanelEpoch();
  const host = createPanelHost();
  const checkGate = deferred();
  const { openUpdatePicker } = createUpdateHarness(host, checkGate);

  openUpdatePicker({});
  await flush();
  host.setPicker(null);
  const paintedBefore = host.painted.length;

  checkGate.resolve({ latestVersion: '0.9.148' });
  await flush();

  assert.equal(host.current(), null);
  assert.equal(host.painted.length, paintedBefore);
});

test('App.jsx routes every picker handover through shouldSupersedePanelEpoch', async () => {
  // No JSX parser exists in this workspace, so the one line that cannot be
  // executed from a test is pinned as source text.
  const source = await readFile(new URL('../App.jsx', import.meta.url), 'utf8');
  assert.match(source, /import \{ shouldSupersedePanelEpoch, supersedePanelEpoch \} from '\.\/app\/panel-epoch\.mjs';/);
  assert.match(
    source,
    /if \(shouldSupersedePanelEpoch\(previousPicker, livePickerRef\.current\)\) supersedePanelEpoch\(\);/,
  );
});

// ── Pending-open resurrection: the epoch must be captured at the OPEN action ──
// A panel whose first paint waits on a daemon read has nothing to protect it:
// null → panel is deliberately not a handover, so a close during the pending
// open would let it paint over the surface the user went back to.

test('Esc during the Update panel pending first read keeps it off the surface', async () => {
  supersedePanelEpoch();
  const host = createPanelHost();
  host.setPicker({ title: 'Settings' });
  const readGate = deferred();
  const checkGate = deferred();
  const noop = () => {};
  const { openUpdatePicker } = createMaintenancePickers({
    store: {
      pushNotice: () => {},
      getUpdateSettings: () => readGate.promise,
      getUpdateStatus: async () => ({ phase: 'idle' }),
      checkForUpdate: () => checkGate.promise,
    },
    theme: {},
    formatDuration: (ms) => `${ms}ms`,
    surface: host.surface,
    setProviderPrompt: noop,
    setSettingsPrompt: noop,
    closeUsagePanel: noop,
  });

  openUpdatePicker({});
  await flush();
  // Still pending: Settings is what the user sees.
  assert.equal(host.current().title, 'Settings');

  // Esc closes Settings while the open is in flight.
  host.setPicker(null);
  const paintedBefore = host.painted.length;

  readGate.resolve({ currentVersion: '0.9.147', autoUpdate: false });
  await flush();
  assert.equal(host.current(), null);
  assert.equal(host.painted.length, paintedBefore);

  // The abandoned open must not come back through its own initial check either.
  checkGate.resolve({ latestVersion: '0.9.148' });
  await flush();
  assert.equal(host.current(), null);
  assert.equal(host.painted.length, paintedBefore);
});

test('Esc during a pending Settings open leaves the surface untouched', async () => {
  supersedePanelEpoch();
  const host = createPanelHost();
  host.setPicker({ title: 'Core memories' });
  const snapshotGate = deferred();
  const harness = createSettingsHarness({
    host,
    store: { getSettingsSnapshot: () => snapshotGate.promise },
  });

  const opening = harness.openSettingsPicker();
  host.setPicker(null);
  const paintedBefore = host.painted.length;

  snapshotGate.resolve({});
  await opening;
  await flush();

  assert.equal(host.current(), null);
  assert.equal(host.painted.length, paintedBefore);
});

test('Esc during a pending Hooks open keeps the panel off the surface', async () => {
  supersedePanelEpoch();
  const host = createPanelHost();
  host.setPicker({ title: 'Settings' });
  const statusGate = deferred();
  const noop = () => {};
  const { openHooksPicker } = createExtensionPickers({
    store: { pushNotice: () => {}, hooksStatus: () => statusGate.promise },
    theme: {},
    clean: (value) => value,
    copyToClipboard: noop,
    surface: host.surface,
    getPicker: host.current,
    setProviderPrompt: noop,
    setSettingsPrompt: noop,
    getDisabledSkills: () => new Set(),
    setDisabledSkills: noop,
  });

  void openHooksPicker();
  host.setPicker(null);
  const paintedBefore = host.painted.length;

  statusGate.resolve({ rules: [], events: [], recent: [] });
  await flush();

  assert.equal(host.current(), null);
  assert.equal(host.painted.length, paintedBefore);
});

test('an uninterrupted open still paints and keeps repainting', async () => {
  supersedePanelEpoch();
  const host = createPanelHost();
  const statusGate = deferred();
  const noop = () => {};
  const { openHooksPicker } = createExtensionPickers({
    store: { pushNotice: () => {}, hooksStatus: () => statusGate.promise },
    theme: {},
    clean: (value) => value,
    copyToClipboard: noop,
    surface: host.surface,
    getPicker: host.current,
    setProviderPrompt: noop,
    setSettingsPrompt: noop,
    getDisabledSkills: () => new Set(),
    setDisabledSkills: noop,
  });

  void openHooksPicker();
  statusGate.resolve({ rules: [{ index: 0, tool: 'shell', action: 'ask', enabled: true }], events: [], recent: [] });
  await flush();
  assert.equal(host.current()._kind, 'hooks');

  // A same-surface reopen (the toggle path) still paints: the guard only
  // blocks opens whose surface was handed over while they were pending.
  const paintedBefore = host.painted.length;
  void openHooksPicker();
  await flush();
  assert.ok(host.painted.length > paintedBefore);
  assert.equal(host.current()._kind, 'hooks');
});

// ── Late REPAINTS must prove ownership too, not just the first paint ─────────
// A panel that keeps a render closure alive (Update, Auto-clear, Model) repaints
// from later daemon reads; those reads settle after Esc just as easily as the
// opening one.

test('probe: an Update re-check settling after Esc paints nothing', async () => {
  supersedePanelEpoch();
  const host = createPanelHost();
  let readGate = null;
  let reads = 0;
  const checkGate = deferred();
  checkGate.resolve({});
  const noop = () => {};
  const { openUpdatePicker } = createMaintenancePickers({
    store: {
      pushNotice: () => {},
      getUpdateSettings: () => { reads += 1; return readGate ? readGate.promise : Promise.resolve({ currentVersion: '0.9.147' }); },
      getUpdateStatus: async () => ({ phase: 'idle' }),
      checkForUpdate: () => checkGate.promise,
    },
    theme: {},
    formatDuration: (ms) => `${ms}ms`,
    surface: host.surface,
    setProviderPrompt: noop,
    setSettingsPrompt: noop,
    closeUsagePanel: noop,
  });

  openUpdatePicker({});
  await flush();
  assert.equal(host.current().title, 'Update');

  // Enter on "Latest version" → recheck(): a fresh daemon read feeds a repaint.
  readGate = deferred();
  host.current().onSelect('latest', { _action: 'latest' });
  await flush();
  host.setPicker(null);
  const paintedBefore = host.painted.length;

  readGate.resolve({ currentVersion: '0.9.147' });
  await flush();

  assert.ok(reads >= 2, 're-check must have issued its own read');
  assert.equal(host.current(), null, 'afterEsc');
  assert.equal(host.painted.length - paintedBefore, 0, 'latePaints');
});

test('probe: an Auto-clear read settling after Esc paints nothing', async () => {
  supersedePanelEpoch();
  const host = createPanelHost();
  const autoClear = { enabled: true, idleMs: 3_600_000, providerDefaults: [] };
  let readGate = null;
  let reads = 0;
  const noop = () => {};
  const { openAutoClearPicker } = createMaintenancePickers({
    store: {
      pushNotice: () => {},
      getAutoClear: () => { reads += 1; return readGate ? readGate.promise : Promise.resolve(autoClear); },
    },
    theme: { success: '' },
    formatDuration: (ms) => `${ms}ms`,
    surface: host.surface,
    setProviderPrompt: noop,
    setSettingsPrompt: noop,
    closeUsagePanel: noop,
  });

  openAutoClearPicker({});
  await flush();
  assert.equal(host.current().title, 'Auto-clear');

  // Enter on "Advanced" → renderAdvanced(): another daemon read, another paint.
  readGate = deferred();
  host.current().onSelect('advanced', { _action: 'advanced' });
  await flush();
  host.setPicker(null);
  const paintedBefore = host.painted.length;

  readGate.resolve(autoClear);
  await flush();

  assert.ok(reads >= 2, 'Advanced must have issued its own read');
  assert.equal(host.current(), null, 'afterEsc');
  assert.equal(host.painted.length - paintedBefore, 0, 'latePaints');
});

test('probe: a model load completing after Esc paints nothing', async () => {
  supersedePanelEpoch();
  const host = createPanelHost();
  const loadGate = deferred();
  const noop = () => {};
  const { openModelPicker } = createModelPicker({
    store: { pushNotice: () => {}, listProviderModels: () => loadGate.promise },
    getState: () => ({ provider: 'openai', model: 'gpt-5', effort: null, fast: false }),
    surface: host.surface,
    setProviderPrompt: noop,
    setSettingsPrompt: noop,
    providerModelsCacheRef: { current: { models: [], at: 0 } },
    webSearchModelsCacheRef: { current: { models: [], at: 0 } },
    modelPickerRequestRef: { current: 0 },
    clearModelCaches: noop,
    modelSwitchNotice: () => 'switched',
    // NOT stubbed away: the empty-catalog fallback really opens Providers, and
    // a stub would hide an unguarded delegation.
    openProviderSetupPicker: () => { host.setPicker({ title: 'Providers' }); },
  });

  void openModelPicker({ refreshModels: true });
  await flush();
  // The synchronous loading frame is on screen; Esc closes it mid-load.
  assert.equal(host.current().title, 'Model');
  host.setPicker(null);
  const paintedBefore = host.painted.length;

  loadGate.resolve([{ provider: 'openai', id: 'gpt-5', label: 'GPT-5' }]);
  await flush();

  assert.equal(host.current(), null, 'afterEsc');
  assert.equal(host.painted.length - paintedBefore, 0, 'latePaints');
});

test('probe: onboarding Step 1 does not paint when Esc lands during its read', async () => {
  supersedePanelEpoch();
  const host = createPanelHost();
  host.setPicker({ title: 'Settings' });
  const setupGate = deferred();
  const opened = [];
  const noop = () => {};
  const { openOnboardingAuthStep } = createOnboardingSteps({
    store: { pushNotice: () => {}, getProviderSetup: () => setupGate.promise },
    surface: host.surface,
    setProviderPrompt: noop,
    setSettingsPrompt: noop,
    setOnboardingActive: noop,
    onboardingRef: { current: { providerModels: [{ provider: 'openai', id: 'gpt-5' }], agents: [{ id: 'lead' }] } },
    providerModelsCacheRef: { current: { models: [], at: 0 } },
    onboardingPrefetchSeqRef: { current: 0 },
    openProviderSetupPicker: (options) => { opened.push(options?.title); },
    openThemePicker: noop,
    openOutputStylePicker: noop,
  });

  void openOnboardingAuthStep();
  await flush();
  host.setPicker(null);
  const paintedBefore = host.painted.length;

  setupGate.resolve({ providers: [] });
  await flush();

  assert.deepEqual(opened, [], 'Step 1 must not open');
  assert.equal(host.current(), null, 'afterEsc');
  assert.equal(host.painted.length - paintedBefore, 0, 'latePaints');
});

// ── Post-await DELEGATION: handing the surface to ANOTHER panel is a paint ───
// Empty-result / error / no-op fallbacks reach a different panel without going
// through this opener's paint path, so they need the same ownership proof.

function createModelHarness(host, loadGate) {
  const noop = () => {};
  const opened = [];
  const notices = [];
  const { openModelPicker } = createModelPicker({
    store: { pushNotice: (message) => notices.push(String(message)), listProviderModels: () => loadGate.promise },
    getState: () => ({ provider: 'openai', model: 'gpt-5' }),
    surface: host.surface,
    setProviderPrompt: noop,
    setSettingsPrompt: noop,
    providerModelsCacheRef: { current: { models: [], at: 0 } },
    webSearchModelsCacheRef: { current: { models: [], at: 0 } },
    modelPickerRequestRef: { current: 0 },
    clearModelCaches: noop,
    modelSwitchNotice: () => 'switched',
    openProviderSetupPicker: () => {
      opened.push('Providers');
      host.setPicker({ title: 'Providers' });
    },
  });
  return { openModelPicker, opened, notices };
}

// Proof that the branch under test actually ran: without it a probe passes for
// the wrong reason (the chain simply had not reached the delegation yet).
const branchRan = (notices, pattern, label) => assert.ok(
  notices.some((message) => pattern.test(message)),
  `${label}: the branch under test did not run`,
);

test('probe: the empty-catalog fallback does not delegate to Providers after Esc', async () => {
  supersedePanelEpoch();
  const host = createPanelHost();
  const loadGate = deferred();
  const { openModelPicker, opened, notices } = createModelHarness(host, loadGate);

  void openModelPicker({ refreshModels: true });
  await flush();
  assert.equal(host.current().title, 'Model');
  host.setPicker(null);
  const paintedBefore = host.painted.length;

  loadGate.resolve([]); // empty catalog → Providers fallback branch
  await flush();

  branchRan(notices, /no provider models available/, 'empty-catalog');
  assert.deepEqual(opened, [], 'Providers must not open');
  assert.equal(host.current(), null, 'afterEsc');
  assert.equal(host.painted.length - paintedBefore, 0, 'latePaints');
});

test('probe: an uninterrupted empty catalog still delegates to Providers', async () => {
  supersedePanelEpoch();
  const host = createPanelHost();
  const loadGate = deferred();
  const { openModelPicker, opened } = createModelHarness(host, loadGate);

  void openModelPicker({ refreshModels: true });
  await flush();
  loadGate.resolve([]);
  await flush();

  assert.deepEqual(opened, ['Providers']);
  assert.equal(host.current().title, 'Providers');
});

function createOnboardingHarness(host, overrides = {}) {
  const noop = () => {};
  const opened = [];
  const notices = [];
  const steps = createOnboardingSteps({
    store: {
      pushNotice: (message) => notices.push(String(message)),
      getProviderSetup: async () => ({ providers: [] }),
      listProviderModels: async () => [{ provider: 'openai', id: 'gpt-5' }],
      listWebSearchModels: async () => [],
      listAgents: async () => [],
      ...overrides,
    },
    surface: host.surface,
    setProviderPrompt: noop,
    setSettingsPrompt: noop,
    setOnboardingActive: noop,
    onboardingRef: { current: {} },
    providerModelsCacheRef: { current: { models: [], at: 0 } },
    onboardingPrefetchSeqRef: { current: 0 },
    // Step 1 is a real panel here too, so an unguarded fallback shows as a paint.
    openProviderSetupPicker: (options) => {
      opened.push(options?.title);
      host.setPicker({ title: options?.title || 'Providers' });
    },
    openThemePicker: noop,
    openOutputStylePicker: noop,
  });
  return { steps, opened, notices };
}

test('probe: Step 2 empty-model fallback does not reopen Step 1 after Esc', async () => {
  supersedePanelEpoch();
  const host = createPanelHost();
  host.setPicker({ title: 'Settings' });
  const modelsGate = deferred();
  const { steps, opened, notices } = createOnboardingHarness(host, { listProviderModels: () => modelsGate.promise });

  void steps.openOnboardingWorkflowStep();
  await flush();
  host.setPicker(null);
  const paintedBefore = host.painted.length;

  modelsGate.resolve([]); // empty models → Step 1 fallback branch
  await flush();

  branchRan(notices, /no provider models available/, 'empty-models');
  assert.deepEqual(opened, [], 'Step 1 must not open');
  assert.equal(host.current(), null, 'afterEsc');
  assert.equal(host.painted.length - paintedBefore, 0, 'latePaints');
});

test('probe: the onboarding Web Search fallback does not jump to Step 2 after Esc', async () => {
  supersedePanelEpoch();
  const host = createPanelHost();
  host.setPicker({ title: 'Settings' });
  const webSearchGate = deferred();
  const { steps, notices } = createOnboardingHarness(host, { listWebSearchModels: () => webSearchGate.promise });

  void steps.openOnboardingRoleModelPicker('webSearch');
  await flush();
  host.setPicker(null);
  const paintedBefore = host.painted.length;

  webSearchGate.resolve([]); // empty list → "back to Step 2" fallback branch
  await flush();

  branchRan(notices, /no native web-search models available/, 'empty-web-search');
  assert.equal(host.current(), null, 'afterEsc');
  assert.equal(host.painted.length - paintedBefore, 0, 'latePaints');
});

// ── The class rule, now STRUCTURAL ──────────────────────────────────────────
// This used to be an AST analyzer over arbitrary JavaScript, and every review
// round defeated it in a new way (guard polarity, member/showX calls, renamed
// re-exported aliases, callbacks handed to other modules, stored callbacks,
// reassigned bindings, yield, labelled break, class fields). It is replaced by
// two facts nothing has to infer: the raw sinks do not exist outside the owning
// layer, and the only way in — a claim — validates ownership at the sink.
const OWNING_LAYER = new Set(['App.jsx', 'panel-surface.mjs']);
const RAW_SINKS = /\b(?:setPicker|setContextPanel|setUsagePanel)\b/;

// Sources only: src/tui/dist/index.mjs is a bundle of exactly these files.
const GENERATED = new Set(['dist', 'node_modules']);

async function sourceFiles(directory) {
  const out = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!GENERATED.has(entry.name)) out.push(...await sourceFiles(full));
    }
    else if (/\.(?:mjs|jsx|js)$/.test(entry.name) && !entry.name.endsWith('.test.mjs')) out.push(full);
  }
  return out;
}

test('audit: the raw panel sinks are unreachable outside the owning layer', async () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const offenders = [];
  for (const file of await sourceFiles(root)) {
    if (OWNING_LAYER.has(basename(file))) continue;
    const source = await readFile(file, 'utf8');
    if (RAW_SINKS.test(source)) offenders.push(relative(root, file));
  }
  // Nothing to alias, rename, or smuggle through a callback: outside these two
  // files the sink names do not occur at all.
  assert.deepEqual(offenders, []);
});

test('audit: a claim rejects every late-paint shape once the surface changed hands', async () => {
  supersedePanelEpoch();
  const host = createPanelHost();
  host.setPicker({ title: 'Settings' });
  const own = host.surface.claim();

  // Every shape that defeated the analyzer, built while the claim is valid: an
  // alias, a member call, a stored callback, a class field, and a callback
  // handed to a foreign module that decides when to run it.
  const alias = own.paint;
  const holder = { paint: own.paint };
  const stored = () => own.paint({ title: 'Stored' });
  class LatePanel { painted = own.paint({ title: 'Field' }); }
  let subscriber = null;
  const foreignModule = { subscribe: (fn) => { subscriber = fn; } };
  foreignModule.subscribe(() => own.paint({ title: 'Pushed' }));

  // Undisturbed they all paint, so the probe below is not vacuous.
  const beforeValid = host.painted.length;
  alias({ title: 'Alias' });
  holder.paint({ title: 'Member' });
  stored();
  void new LatePanel();
  subscriber();
  // Bound to the surface this action currently holds, exactly like the openers.
  const deferredPaint = own.defer(() => own.paint({ title: 'Deferred' }));
  deferredPaint();
  assert.equal(host.painted.length - beforeValid, 6, 'validPaints');

  // Esc: the user takes the surface back, and the async work settles after it.
  host.setPicker(null);
  await flush(1);
  const afterEsc = host.painted.length;
  alias({ title: 'Alias' });
  holder.paint({ title: 'Member' });
  stored();
  void new LatePanel();
  subscriber();
  deferredPaint();
  assert.equal(host.painted.length - afterEsc, 0, 'latePaints');
  assert.equal(host.current(), null);
});

test('probe: a late Agent "Not used" ack does not overwrite the replacement panel', async () => {
  supersedePanelEpoch();
  const host = createPanelHost();
  const saveGate = deferred();
  const noop = () => {};
  const notices = [];
  const { openAgentsPicker } = createRoutePickers({
    store: {
      pushNotice: (message) => notices.push(String(message)),
      listAgents: async () => [{ id: 'reviewer', label: 'Reviewer', description: 'reviews', route: {} }],
      setAgentRoute: () => saveGate.promise,
    },
    state: {},
    surface: host.surface,
    setProviderPrompt: noop,
    setSettingsPrompt: noop,
    closeUsagePanel: noop,
    clean: (value) => value,
    routeLabel: () => 'route',
    agentModelParts: () => [],
    agentModelProfile: () => 'profile',
    workflowSwitchNotice: () => 'switched',
    openModelPicker: noop,
  });

  await openAgentsPicker();
  await flush();
  const agents = host.current();
  assert.equal(agents.title, 'Agents');
  agents.onSelect('reviewer', agents.items[0]);
  const agentPanel = host.current();
  assert.equal(agentPanel.title, 'Reviewer');

  void agentPanel.onSelect('off'); // Enter on "Not used": the write starts
  // Something else takes the surface before the ack lands.
  host.setPicker({ title: 'Settings' });
  const paintedBefore = host.painted.length;

  saveGate.resolve({ disabled: true });
  await flush();

  branchRan(notices, /no longer used/, 'agent-off');
  assert.equal(host.current().title, 'Settings', 'afterReplacement');
  assert.equal(host.painted.length - paintedBefore, 0, 'latePaints');
});

test('probe: an undisturbed Agent "Not used" ack still reopens Agents', async () => {
  supersedePanelEpoch();
  const host = createPanelHost();
  const saveGate = deferred();
  const noop = () => {};
  const { openAgentsPicker } = createRoutePickers({
    store: {
      pushNotice: () => {},
      listAgents: async () => [{ id: 'reviewer', label: 'Reviewer', description: 'reviews', route: {} }],
      setAgentRoute: () => saveGate.promise,
    },
    state: {},
    surface: host.surface,
    setProviderPrompt: noop,
    setSettingsPrompt: noop,
    closeUsagePanel: noop,
    clean: (value) => value,
    routeLabel: () => 'route',
    agentModelParts: () => [],
    agentModelProfile: () => 'profile',
    workflowSwitchNotice: () => 'switched',
    openModelPicker: noop,
  });

  await openAgentsPicker();
  await flush();
  host.current().onSelect('reviewer', host.current().items[0]);
  void host.current().onSelect('off');

  saveGate.resolve({ disabled: true });
  await flush();

  assert.equal(host.current().title, 'Agents', 'the undisturbed flow still repaints');
});

test('main-provider Enter still opens the provider action panel', async () => {
  supersedePanelEpoch();
  const host = createPanelHost();
  const noop = () => {};
  const { openProviderSetupPicker } = createProviderSetupPicker({
    store: {
      pushNotice: () => {},
      getProviderSetup: async () => ({
        api: [{ id: 'openai', name: 'OpenAI', authenticated: true, stored: true }],
        oauth: [],
        local: [],
      }),
    },
    surface: host.surface,
    setProviderPrompt: noop,
    setSettingsPrompt: noop,
    closeUsagePanel: noop,
    oauthSubmitRef: { current: false },
    clearModelCaches: noop,
  });

  await openProviderSetupPicker({});
  await flush();
  const list = host.current();
  assert.equal(list.title, 'Providers');

  // Enter on a provider row: in-flow navigation, so the action panel must paint.
  const providerRow = list.items.find((item) => item._type === 'api-key');
  list.onSelect(providerRow.value, providerRow);

  assert.equal(host.current()?.title, 'Provider · OpenAI', 'afterEnter');
  assert.deepEqual(
    host.painted.slice(-2).map((panel) => (panel === null ? null : panel.title)),
    [null, 'Provider · OpenAI'],
  );
});
