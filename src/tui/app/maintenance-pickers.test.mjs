import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as flush } from 'node:timers/promises';
import { shouldSupersedePanelEpoch, supersedePanelEpoch } from './panel-epoch.mjs';
import { createPanelSurface } from './panel-surface.mjs';
import { createMaintenancePickers } from './maintenance-pickers.mjs';

// Update / Auto-clear / Profile / Developer panels against a fake store: rows from the
// daemon reads, what each key writes, and where Esc returns.

function createHarness(storeOverrides = {}, depOverrides = {}) {
  supersedePanelEpoch();
  let live = null;
  const notices = [];
  const prompts = [];
  const cleared = [];
  const surface = createPanelSurface({
    setPicker: (next) => {
      const previous = live;
      live = typeof next === 'function' ? next(previous) : next;
      if (shouldSupersedePanelEpoch(previous, live)) supersedePanelEpoch();
    },
    setContextPanel: () => {},
    setUsagePanel: () => {},
  });
  const pickers = createMaintenancePickers({
    store: { pushNotice: (message, tone) => notices.push([message, tone]), ...storeOverrides },
    theme: { success: 'green' },
    formatDuration: (ms) => `${Math.round(ms / 60_000)}m`,
    surface,
    setProviderPrompt: () => {},
    setSettingsPrompt: (prompt) => prompts.push(prompt),
    closeUsagePanel: () => {},
    clearModelCaches: (scope) => cleared.push(scope),
    ...depOverrides,
  });
  const current = () => live;
  const row = (value) => current().items.find((item) => item.value === value);
  return { ...pickers, current, row, notices, prompts, cleared };
}

test('Update panel: versions from the daemon, auto-update toggle writes then repaints', async () => {
  let autoUpdate = false;
  const writes = [];
  const h = createHarness({
    getUpdateSettings: async () => ({
      currentVersion: '1.0.0',
      latestVersion: '1.1.0',
      updateAvailable: true,
      autoUpdate,
    }),
    getUpdateStatus: async () => ({ phase: 'idle' }),
    checkForUpdate: async () => {},
    setAutoUpdate: async (enabled) => {
      writes.push(enabled);
      autoUpdate = enabled;
    },
  });
  await h.openUpdatePicker({});
  await flush();
  const panel = h.current();
  assert.equal(panel.title, 'Update');
  assert.equal(h.row('current').meta, '1.0.0');
  assert.equal(h.row('latest').meta, '1.1.0');
  assert.equal(h.row('auto-update').meta, 'Off');
  assert.equal(panel.confirmBar.buttons[0].label, 'Update to v1.1.0');

  panel.onSelect('auto-update', h.row('auto-update'));
  await flush();
  assert.deepEqual(writes, [true]);
  assert.deepEqual(h.notices.at(-1), ['Auto-update on', 'info']);
  assert.equal(h.row('auto-update').meta, 'On');
});

test('Update now reports the installed version and the panel shows restart-to-apply', async () => {
  let phase = 'idle';
  const h = createHarness({
    getUpdateSettings: async () => ({ currentVersion: '1.0.0', latestVersion: '1.1.0', updateAvailable: true }),
    getUpdateStatus: async () => (phase === 'installed' ? { phase, version: '1.1.0' } : { phase }),
    checkForUpdate: async () => {},
    runUpdateNow: async () => {
      phase = 'installed';
      return { ok: true, version: '1.1.0' };
    },
  });
  const returned = [];
  await h.openUpdatePicker({ returnTo: () => returned.push(1) });
  await flush();
  h.current().confirmBar.onConfirm({ value: 'update-now' });
  await flush();
  assert.deepEqual(h.notices.at(-1), ['v1.1.0 installed — restart to apply', 'warn']);
  assert.equal(h.row('current').meta, '1.0.0 → 1.1.0');
  assert.equal(h.current().confirmBar.buttons[0].label, 'v1.1.0 installed — restart to apply');
  h.current().onCancel();
  assert.deepEqual(returned, [1]);
  assert.equal(h.current(), null);
});

test('Auto-clear: rows follow the current setting, ←/→ write, Advanced lists provider defaults', async () => {
  let current = {
    enabled: true,
    idleMs: 30 * 60_000,
    provider: 'openai',
    providerDefaults: [
      { provider: 'openai', idleMs: 30 * 60_000, builtInMs: 60 * 60_000, custom: true },
      { provider: 'anthropic', idleMs: 60 * 60_000, builtInMs: 60 * 60_000 },
    ],
  };
  const writes = [];
  const h = createHarness({
    getAutoClear: async () => current,
    setAutoClear: async (patch) => {
      writes.push(patch);
      current = { ...current, ...patch };
      return current;
    },
  });
  await h.openAutoClearPicker({});
  await flush();
  assert.equal(h.current().title, 'Auto-clear');
  assert.equal(h.row('toggle').meta, 'On');
  assert.equal(h.row('toggle').description, 'Clear idle sessions after 30m (openai default) · lead cache TTL 5m.');

  h.current().onLeft(h.row('toggle'));
  await flush();
  assert.deepEqual(writes, [{ enabled: false }]);
  assert.deepEqual(h.notices.at(-1), ['autoclear off', 'info']);
  assert.equal(h.row('toggle').meta, 'Off');
  assert.equal(h.current().description, 'Clear idle context after never · lead cache TTL 1h.');

  h.current().onSelect('advanced', h.row('advanced'));
  await flush();
  assert.equal(h.current().title, 'Auto-clear · Advanced');
  assert.deepEqual(
    h.current().items.map((item) => [item.value, item.marker, item.meta]),
    [
      ['provider:openai', '✓', '30m custom'],
      ['provider:anthropic', '', '60m'],
    ]
  );
  h.current().onSelect('provider:openai', h.row('provider:openai'));
  assert.equal(h.current(), null);
  const prompt = h.prompts.at(-1);
  assert.equal(prompt.kind, 'autoclear-provider');
  assert.equal(prompt.initialValue, '30m');
  assert.match(prompt.hint, /built-in 1h\./);
});

test('Auto-clear: a failing Advanced open or Esc-back render becomes a notice, not an unhandled rejection', async () => {
  let broken = false;
  const current = {
    enabled: true,
    idleMs: 30 * 60_000,
    provider: 'openai',
    providerDefaults: [{ provider: 'openai', idleMs: 30 * 60_000, builtInMs: 60 * 60_000 }],
  };
  const h = createHarness(
    { getAutoClear: async () => current },
    {
      formatDuration: (ms) => {
        if (broken) throw new Error('boom');
        return `${Math.round(ms / 60_000)}m`;
      },
    }
  );
  await h.openAutoClearPicker({});
  await flush();

  broken = true;
  h.current().onSelect('advanced', h.row('advanced'));
  await flush();
  assert.deepEqual(h.notices.at(-1), ['auto-clear panel failed: boom', 'error']);

  broken = false;
  h.current().onSelect('advanced', h.row('advanced'));
  await flush();
  assert.equal(h.current().title, 'Auto-clear · Advanced');
  h.notices.length = 0;
  broken = true;
  h.current().onCancel();
  await flush();
  assert.deepEqual(h.notices.at(-1), ['auto-clear panel failed: boom', 'error']);
});

test('Profile: rows from the profile read, ←/→ cycle language and experience, Enter on Title prompts', async () => {
  const writes = [];
  let profile = {
    title: 'Jay',
    language: 'ko',
    experienceLevel: 'vibe-coder',
    languages: [
      { id: 'system', label: 'System (locale)' },
      { id: 'ko', label: 'Korean' },
      { id: 'en', label: 'English' },
    ],
  };
  const h = createHarness({
    getProfile: async () => profile,
    setProfile: async (patch) => {
      writes.push(patch);
      profile = { ...profile, ...patch };
    },
  });
  await h.openProfilePicker({});
  const panel = h.current();
  assert.equal(panel.title, 'Profile');
  assert.deepEqual(
    panel.items.map((item) => [item.value, item.meta]),
    [
      ['title', 'Jay'],
      ['experience-level', 'Vibe coder'],
      ['language', 'Korean'],
    ]
  );

  panel.onRight(h.row('language'));
  await flush();
  assert.deepEqual(writes, [{ language: 'en' }]);
  assert.deepEqual(h.notices.at(-1), ['Language set to English', 'info']);
  assert.equal(h.row('language').meta, 'English');

  h.current().onLeft(h.row('experience-level'));
  await flush();
  assert.deepEqual(writes.at(-1), { experienceLevel: 'beginner' });
  assert.equal(h.row('experience-level').meta, 'Beginner');

  h.current().onSelect('title', h.row('title'));
  assert.equal(h.current(), null);
  assert.equal(h.prompts.at(-1).kind, 'profile-title');
});

test('Profile with no experience level starts cycling from the first/last entry', async () => {
  const writes = [];
  const h = createHarness({
    getProfile: async () => ({}),
    setProfile: async (patch) => {
      writes.push(patch);
    },
  });
  await h.openProfilePicker({});
  assert.equal(h.row('experience-level').meta, '(not set)');
  assert.equal(h.row('language').meta, 'System (locale)');
  h.current().onLeft(h.row('experience-level'));
  await flush();
  assert.deepEqual(writes, [{ experienceLevel: 'expert' }]);
  h.current().onRight(h.row('experience-level'));
  await flush();
  assert.deepEqual(writes.at(-1), { experienceLevel: 'beginner' });
});

const OAUTH_RISK_WARNING =
  'Using this provider through OAuth carries a high risk of penalties such as account restrictions.';

function developerStore() {
  const values = { antigravityOAuth: false, cursorOAuth: false, traceWire: false, verbose: true };
  const writes = [];
  const option = (id, label, extra = {}) => ({
    id,
    label,
    description: `${label} description.`,
    ...extra,
    enabled: values[id],
  });
  const view = () => ({
    sections: [
      {
        id: 'providers',
        label: 'Providers',
        options: [
          option('antigravityOAuth', 'Gemini (Antigravity)', {
            warning: OAUTH_RISK_WARNING,
            provider: 'antigravity-oauth',
          }),
          option('cursorOAuth', 'Cursor', { warning: OAUTH_RISK_WARNING, provider: 'cursor-oauth' }),
        ],
      },
      {
        id: 'diagnostics',
        label: 'Diagnostics',
        options: [option('traceWire', 'Trace wire'), option('verbose', 'Verbose')],
      },
    ],
  });
  return {
    writes,
    store: {
      getDeveloperSettings: async () => view(),
      setDeveloperOption: async (id, enabled) => {
        writes.push([id, enabled]);
        values[id] = enabled;
        return view();
      },
    },
  };
}

test('Developer: sections render from the data, Enter opens a section, Esc walks back to Settings', async () => {
  const { store } = developerStore();
  const h = createHarness(store);
  const returned = [];
  await h.openDeveloperPicker({ returnTo: () => returned.push('settings') });
  await flush();
  assert.equal(h.current().title, 'Developer');
  assert.deepEqual(
    h.current().items.map((item) => [item.value, item.label, item.meta]),
    [
      ['providers', 'Providers', '0 on'],
      ['diagnostics', 'Diagnostics', '1 on'],
    ]
  );

  h.current().onSelect('diagnostics', h.row('diagnostics'));
  await flush();
  assert.equal(h.current().title, 'Developer · Diagnostics');
  assert.deepEqual(
    h.current().items.map((item) => [item.value, item.meta]),
    [
      ['traceWire', 'Off'],
      ['verbose', 'On'],
    ]
  );

  h.current().onCancel();
  await flush();
  assert.equal(h.current().title, 'Developer');
  assert.equal(h.current().items[h.current().initialIndex].value, 'diagnostics');
  h.current().onCancel();
  assert.equal(h.current(), null);
  assert.deepEqual(returned, ['settings']);
});

test('Developer: ←/→ set and Enter flips an option', async () => {
  const { store, writes } = developerStore();
  const h = createHarness(store);
  await h.openDeveloperPicker({});
  await flush();
  h.current().onSelect('diagnostics', h.row('diagnostics'));
  await flush();
  assert.equal(h.current().title, 'Developer · Diagnostics');
  assert.equal(h.row('traceWire').meta, 'Off');

  h.current().onRight(h.row('traceWire'));
  await flush();
  assert.deepEqual(writes, [['traceWire', true]]);
  assert.deepEqual(h.notices.at(-1), ['Trace wire on', 'info']);
  assert.equal(h.row('traceWire').meta, 'On');

  h.current().onSelect('traceWire', h.row('traceWire'));
  await flush();
  assert.deepEqual(writes.at(-1), ['traceWire', false]);
  assert.deepEqual(h.notices.at(-1), ['Trace wire off', 'info']);
  assert.equal(h.row('traceWire').meta, 'Off');

  h.current().onLeft(h.row('traceWire'));
  await flush();
  assert.equal(writes.length, 2, 'setting the current value writes nothing');
  assert.deepEqual(h.cleared, [], 'an option without a provider leaves the model catalog alone');
});

test('Developer: an option with a warning turns on only after its confirmation; off needs none', async () => {
  const { store, writes } = developerStore();
  const h = createHarness(store);
  await h.openDeveloperPicker({});
  await flush();
  h.current().onSelect('providers', h.row('providers'));
  await flush();
  assert.deepEqual(
    h.current().items.map((item) => [item.label, item.meta]),
    [
      ['Gemini (Antigravity)', 'Off'],
      ['Cursor', 'Off'],
    ]
  );

  h.current().onRight(h.row('cursorOAuth'));
  await flush();
  assert.equal(h.current().title, 'Turn on Cursor');
  assert.deepEqual(
    h.current().items.map((item) => item.value),
    ['cancel', 'accept']
  );
  const lines = h.current().footer.map((line) => line.text);
  assert.ok(lines.length > 1 && lines.every((line) => line.length <= 60), 'the warning is wrapped, not truncated');
  assert.equal(lines.join(' '), OAUTH_RISK_WARNING);
  assert.deepEqual(writes, [], 'the warning asks before writing');

  h.current().onSelect('cancel', h.row('cancel'));
  await flush();
  assert.equal(h.current().title, 'Developer · Providers');
  h.current().onSelect('cursorOAuth', h.row('cursorOAuth'));
  await flush();
  h.current().onCancel();
  await flush();
  assert.equal(h.current().title, 'Developer · Providers');
  assert.equal(h.row('cursorOAuth').meta, 'Off');
  assert.deepEqual(writes, [], 'Cancel and Esc write nothing');
  assert.deepEqual(h.cleared, []);

  h.current().onRight(h.row('cursorOAuth'));
  await flush();
  h.current().onSelect('accept', h.row('accept'));
  await flush();
  assert.deepEqual(writes, [['cursorOAuth', true]]);
  assert.deepEqual(h.notices.at(-1), ['Cursor on', 'info']);
  assert.equal(h.current().title, 'Developer · Providers');
  assert.equal(h.row('cursorOAuth').meta, 'On');
  assert.equal(h.row('antigravityOAuth').meta, 'Off', 'each provider has its own toggle');
  assert.deepEqual(h.cleared, ['all'], 'turning a provider on drops the cached model list');

  h.current().onLeft(h.row('cursorOAuth'));
  await flush();
  assert.deepEqual(writes.at(-1), ['cursorOAuth', false]);
  assert.equal(h.row('cursorOAuth').meta, 'Off');
  assert.deepEqual(h.cleared, ['all', 'all'], 'turning it off drops the cached model list too');
});
