import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldSupersedePanelEpoch, supersedePanelEpoch } from './panel-epoch.mjs';
import { createPanelSurface } from './panel-surface.mjs';
import { createMaintenancePickers } from './maintenance-pickers.mjs';

// Update / Auto-clear / Profile panels against a fake store: rows from the
// daemon reads, what each key writes, and where Esc returns.

const flush = async (rounds = 8) => {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setImmediate(resolve));
  }
};

function createHarness(storeOverrides = {}) {
  supersedePanelEpoch();
  let live = null;
  const notices = [];
  const prompts = [];
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
  });
  const current = () => live;
  const row = (value) => current().items.find((item) => item.value === value);
  return { ...pickers, current, row, notices, prompts };
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
  assert.equal(h.row('toggle').description, 'Clear idle sessions after 30m · lead cache TTL 5m.');

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
