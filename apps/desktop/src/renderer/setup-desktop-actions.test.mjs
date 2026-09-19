import assert from 'node:assert/strict';
import test from 'node:test';
import { executeSetupDesktopAction } from './setup-desktop-actions.ts';
import { DESKTOP_SETUP_SETTING_ACTIONS } from '../shared/setup-settings-coverage.ts';
import { desktopSettingsFromConfig } from '../main/settings-store.ts';
import { SETUP_ACTIONS } from '../../../../src/session-runtime/setup-tool/tool-defs.mjs';
import { DESKTOP_READ_CAPABILITIES } from '../shared/contract.ts';
import { SESSION_READ_ACTIONS } from '../../../../src/standalone/session-protocol.mjs';

function fixture() {
  let settings = desktopSettingsFromConfig({});
  let projects = [{ path: '/project', name: 'project', alias: null }];
  let voice = { installed: false, enabled: false };
  let clients = [
    { id: 'phone', name: 'Phone', platform: 'mobile', browser: 'Browser', createdAt: 1, lastSeenAt: 2, online: true },
  ];
  const instructions = new Map([
    [null, 'Common'],
    ['/project', 'Project'],
  ]);
  const writes = [];
  const api = {
    readSettings: async () => ({ ...settings }),
    updateSetting: async (key, value) => {
      writes.push([key, value]);
      settings = { ...settings, [key]: value };
      return settings;
    },
    listProjects: async () => projects.map((project) => ({ ...project })),
    addProject: async (path) => {
      projects.push({ path, name: path, alias: null });
    },
    renameProject: async (path, alias) => {
      projects = projects.map((project) => (project.path === path ? { ...project, alias } : project));
    },
    removeProject: async (path) => {
      projects = projects.filter((project) => project.path !== path);
    },
    readInstructions: async (path) => instructions.get(path),
    writeInstructions: async (path, content, expected) => {
      assert.equal(instructions.get(path), expected);
      instructions.set(path, content);
      return { backupPath: '/retained-backup/previous.md' };
    },
    getRemoteAccessInfo: async () => ({
      relayBrowserUrl: 'credential-canary',
      relayBrowserQrSvg: 'secret-qr',
      clients,
    }),
    revokeRemoteAccessClient: async (id) => {
      clients = clients.filter((client) => client.id !== id);
      return api.getRemoteAccessInfo();
    },
    invokeCapability: async ({ capability, args }) => {
      if (capability === 'getVoiceStatus') return { value: voice };
      assert.equal(capability, 'toggleVoice');
      voice = { installed: true, enabled: args[0] };
      return { value: voice };
    },
  };
  const preferences = {
    read: async () => ({ theme: 'dark' }),
    write: async (next) => ({ ...next, saved: true, requiresReload: true, appliesTo: 'next window reload' }),
  };
  return { api, writes, instructions, run: (args) => executeSetupDesktopAction(args, api, preferences, 'session') };
}

test('every persisted Desktop setting is classified and points to a real setup action', () => {
  assert.deepEqual(
    Object.keys(DESKTOP_SETUP_SETTING_ACTIONS).sort(),
    Object.keys(desktopSettingsFromConfig({})).sort()
  );
  for (const action of Object.values(DESKTOP_SETUP_SETTING_ACTIONS)) assert.ok(SETUP_ACTIONS.includes(action));
  assert.ok(DESKTOP_READ_CAPABILITIES.includes('isSetupRequestActive'));
  assert.ok(SESSION_READ_ACTIONS.includes('isSetupRequestActive'));
});

test('Desktop changes use existing setters and preserve false and unrelated values', async () => {
  const { run, api, writes } = fixture();
  const before = await api.readSettings();
  const result = await run({
    action: 'set_desktop_settings',
    desktop: { keepAwake: false, computerObserveOnly: true },
  });
  assert.equal(result.saved, true);
  assert.equal(result.scope, 'desktop-host');
  assert.deepEqual(writes, [
    ['keepAwake', false],
    ['computerObserveOnly', true],
  ]);
  assert.deepEqual(result.settings, { ...before, keepAwake: false, computerObserveOnly: true });
  await assert.rejects(
    run({ action: 'set_desktop_settings', desktop: { keepAwake: true, notASetting: false } }),
    /Unsupported/
  );
  assert.equal(writes.length, 2);
});

test('Browser install and toggle are separate; voice installation uses the existing managed runtime', async () => {
  const { run } = fixture();
  await assert.rejects(run({ action: 'set_builtin_enabled', name: 'browser', enabled: true }), /Install browser/);
  const installed = await run({ action: 'install_builtin', name: 'browser' });
  assert.equal(installed.settings.browserInstalled, true);
  assert.equal(installed.settings.browserControl, true);
  const disabled = await run({ action: 'set_builtin_enabled', name: 'browser', enabled: false });
  assert.equal(disabled.settings.browserInstalled, true);
  assert.equal(disabled.settings.browserControl, false);
  const voice = await run({ action: 'install_builtin', name: 'voice' });
  assert.deepEqual(voice.voice, { installed: true, enabled: true });
  const off = await run({ action: 'set_builtin_enabled', name: 'voice', enabled: false });
  assert.equal(off.voice.installed, true);
  assert.equal(off.voice.enabled, false);
});

test('appearance reports host scope and reload requirement without restarting the app', async () => {
  const result = await fixture().run({ action: 'set_appearance', appearance: { displayLanguage: 'ko' } });
  assert.equal(result.saved, true);
  assert.equal(result.scope, 'desktop-host');
  assert.equal(result.requiresReload, true);
  assert.equal(result.displayLanguage, 'ko');
});

test('Project registration, alias and removal do not expose a file-deletion operation', async () => {
  const { run } = fixture();
  const saved = await run({ action: 'save_project', project: { path: '/new', alias: 'New project' } });
  assert.equal(saved.projects.find((project) => project.path === '/new').alias, 'New project');
  await assert.rejects(run({ action: 'remove_project', projectPath: null }), /exact registered/);
  const removed = await run({ action: 'remove_project', projectPath: '/new' });
  assert.equal(
    removed.projects.some((project) => project.path === '/new'),
    false
  );
  assert.match(removed.recovery, /files remain/);
});

test('Instructions distinguish Common from Project and forward the exact concurrency precondition', async () => {
  const { run, instructions } = fixture();
  const before = await run({ action: 'get_instructions', projectPath: null });
  assert.equal(before.scope, 'common');
  const saved = await run({
    action: 'set_instructions',
    projectPath: null,
    expectedContent: before.content,
    content: 'New Common',
  });
  assert.equal(saved.content, 'New Common');
  assert.equal(saved.backupPath, '/retained-backup/previous.md');
  assert.equal(instructions.get('/project'), 'Project');
  await assert.rejects(
    run({ action: 'set_instructions', projectPath: '/unknown', expectedContent: '', content: 'x' }),
    /exact registered/
  );
});

test('Connection reads and revocation never return pairing URLs or QR credentials', async () => {
  const { run } = fixture();
  const status = await run({ action: 'status', domain: 'connection' });
  assert.equal(status.clients[0].id, 'phone');
  assert.doesNotMatch(JSON.stringify(status), /credential-canary|secret-qr/);
  const result = await run({ action: 'revoke_linked_device', name: 'phone' });
  assert.deepEqual(result.clients, []);
  assert.doesNotMatch(JSON.stringify(result), /credential-canary|secret-qr/);
  await assert.rejects(run({ action: 'revoke_linked_device', name: 'missing' }), /not found/);
});

test('cancellation between settings stops all remaining mutations and reports the partial save', async () => {
  const { api, writes } = fixture();
  let admitted = 0;
  const assertActive = async () => {
    if (++admitted > 1) throw new Error('cancelled');
  };
  await assert.rejects(
    executeSetupDesktopAction(
      { action: 'set_desktop_settings', desktop: { keepAwake: false, computerObserveOnly: true } },
      api,
      {},
      'session',
      assertActive
    ),
    /Already saved: keepAwake.*cancelled/
  );
  assert.deepEqual(writes, [['keepAwake', false]]);
  assert.equal((await api.readSettings()).computerObserveOnly, false);
});
