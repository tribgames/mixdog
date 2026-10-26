import assert from 'node:assert/strict';
import test from 'node:test';
import { executeSetupDesktopAction } from './setup-desktop-actions.ts';
import { DESKTOP_SETUP_SETTING_ACTIONS } from '../shared/setup-settings-coverage.ts';
import { desktopSettingsFromConfig } from '../main/settings-store.ts';
import { SETUP_ACTIONS } from '../../../../src/session-runtime/setup-tool/tool-defs.mjs';
import { DESKTOP_READ_CAPABILITIES } from '../shared/contract.ts';
import { SESSION_READ_ACTIONS } from '../../../../src/standalone/session-protocol.mjs';
import { SETUP_ACTIVITY_RAIL_PIN_IDS } from '../../../../src/session-runtime/setup-tool/settings-contract.mjs';
import { ACTIVITY_RAIL_PIN_IDS } from '../shared/activity-rail-pins.ts';
import { DESKTOP_PET_SCALES } from '../shared/desktop-pet.ts';

function fixture() {
  let settings = desktopSettingsFromConfig({});
  let projects = [{ path: '/project', name: 'project', alias: null }];
  const voice = { installed: false, enabled: false };
  let clients = [
    { id: 'phone', name: 'Phone', platform: 'mobile', browser: 'Browser', createdAt: 1, lastSeenAt: 2, online: true },
  ];
  let railPins = { pins: ['sessions', 'agents'], revision: 1 };
  const writes = [];
  const api = {
    readActivityRailPins: async () => railPins,
    updateActivityRailPins: async (pins) => {
      railPins = { pins, revision: railPins.revision + 1 };
      return railPins;
    },
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
      assert.equal(capability, 'getVoiceStatus', `unexpected capability ${capability}(${JSON.stringify(args)})`);
      return { value: voice };
    },
  };
  const preferences = {
    read: async () => ({ theme: 'dark' }),
    write: async (next) => ({ ...next, saved: true, requiresReload: true, appliesTo: 'next window reload' }),
  };
  return { api, writes, run: (args) => executeSetupDesktopAction(args, api, preferences, 'session') };
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

test('activity rail pins: setup accepts exactly the Desktop pin ids and replaces the ordered list', async () => {
  assert.deepEqual(SETUP_ACTIVITY_RAIL_PIN_IDS, [...ACTIVITY_RAIL_PIN_IDS]);
  const { run } = fixture();
  const result = await run({ action: 'set_activity_rail_pins', activityRailPins: ['search', 'sessions'] });
  assert.deepEqual(result.activityRailPins, ['search', 'sessions']);
  assert.equal(result.scope, 'desktop-host');
  const status = await run({ action: 'status', domain: 'desktop' });
  assert.deepEqual(status.activityRailPins, ['search', 'sessions']);
  await assert.rejects(run({ action: 'set_activity_rail_pins', activityRailPins: ['nope'] }), /known activity rail/);
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

test('Browser install and toggle are separate; voice is not a Desktop-hosted setup action', async () => {
  const { run } = fixture();
  await assert.rejects(run({ action: 'set_builtin_enabled', name: 'browser', enabled: true }), /Install browser/);
  const installed = await run({ action: 'install_builtin', name: 'browser' });
  assert.equal(installed.settings.browserInstalled, true);
  assert.equal(installed.settings.browserControl, true);
  const disabled = await run({ action: 'set_builtin_enabled', name: 'browser', enabled: false });
  assert.equal(disabled.settings.browserInstalled, true);
  assert.equal(disabled.settings.browserControl, false);
  // The runtime setup tool toggles voice itself; a stray request is refused.
  await assert.rejects(run({ action: 'install_builtin', name: 'voice' }), /Unsupported Desktop built-in/);
  await assert.rejects(
    run({ action: 'set_builtin_enabled', name: 'voice', enabled: false }),
    /Unsupported Desktop built-in/
  );
});

test('Git and Office installs bring in their system dependency before activating the feature', async () => {
  const { api, run } = fixture();
  const calls = [];
  api.installGitCli = async () => {
    calls.push('installGitCli');
    return { installed: true, version: '2.51.0' };
  };
  api.installLibreOffice = async () => {
    calls.push('installLibreOffice');
    return { installed: true, version: '26.8.0.3' };
  };
  const invokeCapability = api.invokeCapability;
  api.invokeCapability = async (request) => {
    if (request.capability !== 'setBuiltinToolEnabled' && request.capability !== 'installBuiltinFeature') {
      return invokeCapability(request);
    }
    calls.push([request.capability, ...request.args]);
    return { value: { [request.args[0]]: { installed: true, enabled: true } } };
  };

  const git = await run({ action: 'install_builtin', name: 'git' });
  assert.deepEqual(git.git, { installed: true, enabled: true });
  assert.equal(git.dependency.version, '2.51.0');
  const office = await run({ action: 'install_builtin', name: 'office' });
  assert.deepEqual(office.office, { installed: true, enabled: true });
  assert.deepEqual(calls, [
    'installGitCli',
    ['setBuiltinToolEnabled', 'git', true],
    'installLibreOffice',
    ['installBuiltinFeature', 'office'],
  ]);

  api.installLibreOffice = async () => ({ installed: false });
  await assert.rejects(run({ action: 'install_builtin', name: 'office' }), /LibreOffice installation did not complete/);
  assert.equal(calls.length, 4, 'a missing dependency never activates the feature');
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

function stubWindow() {
  const store = new Map();
  const target = new EventTarget();
  globalThis.window = {
    localStorage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)) },
    addEventListener: (...a) => target.addEventListener(...a),
    removeEventListener: (...a) => target.removeEventListener(...a),
    dispatchEvent: (e) => target.dispatchEvent(e),
    Event,
    CustomEvent,
  };
}

test('notificationVolume: written via setNotificationVolume, read back in status, invalid rejected', async () => {
  const { api, run } = fixture();
  const calls = [];
  let volume = 100;
  api.readSettings = async () => ({ notificationVolume: volume });
  api.setNotificationVolume = async (v) => {
    calls.push(v);
    volume = v;
    return { notificationVolume: v };
  };
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'Windows' }, configurable: true });
  try {
    const result = await run({ action: 'set_desktop_settings', desktop: { notificationVolume: 250 } });
    assert.equal(result.scope, 'desktop-host');
    assert.deepEqual(calls, [250]);
    assert.equal((await run({ action: 'status', domain: 'desktop' })).notificationVolume, 250);
    for (const bad of [-1, 401, 1.5, '50', true]) {
      await assert.rejects(run({ action: 'set_desktop_settings', desktop: { notificationVolume: bad } }), /0 to 400/);
    }
    assert.deepEqual(calls, [250]);
    Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'Mac' }, configurable: true });
    await assert.rejects(
      run({ action: 'set_desktop_settings', desktop: { notificationVolume: 10 } }),
      /only available on Windows/
    );
  } finally {
    if (original) Object.defineProperty(globalThis, 'navigator', original);
  }
});

test('appearance markdownDefaultView, linkPreview and toolActivityExpansion write, read back and reject bad values', async () => {
  stubWindow();
  const { desktopSetupPreferences } = await import('./use-setup-desktop-request.ts');
  let view = 'preview';
  const api = {
    readMarkdownDefaultView: async () => view,
    writeMarkdownDefaultView: async (v) => (view = v),
  };
  const prefs = desktopSetupPreferences(api);
  const result = await prefs.write({ markdownDefaultView: 'source', linkPreview: false, toolActivityExpansion: 'all' });
  assert.equal(result.saved, true);
  const status = await prefs.read();
  assert.equal(status.markdownDefaultView, 'source');
  assert.equal(status.linkPreview, false);
  assert.equal(status.toolActivityExpansion, 'all');
  await assert.rejects(prefs.write({ markdownDefaultView: 'html' }), /preview, rich or source/);
  await assert.rejects(prefs.write({ linkPreview: 'yes' }), /true or false/);
  await assert.rejects(prefs.write({ toolActivityExpansion: 'some' }), /collapsed, commands or all/);
  const after = await prefs.read();
  assert.equal(after.markdownDefaultView, 'source');
  assert.equal(after.linkPreview, false);
  assert.equal(after.toolActivityExpansion, 'all');
});

test('appearance timeFormat, sidePanelPosition, font sizes, ligatures and chatTextSize write, read back and reject bad values', async (t) => {
  const { installTestDom } = await import('./test-support/test-dom.mjs');
  installTestDom(t, { actEnvironment: false, expose: ['MutationObserver'] });
  const { desktopSetupPreferences } = await import('./use-setup-desktop-request.ts');
  const prefs = desktopSetupPreferences({});
  const start = await prefs.read();
  assert.deepEqual(
    [start.timeFormat, start.sidePanelPosition, start.uiScale, start.codeSize, start.codeLigatures, start.chatTextSize],
    ['system', 'right', 1, 13, true, 'default']
  );
  const result = await prefs.write({
    timeFormat: '24h',
    sidePanelPosition: 'bottom',
    uiScale: 1.15,
    codeSize: 16,
    codeLigatures: false,
    chatTextSize: 'extra-large',
  });
  assert.equal(result.saved, true);
  const stored = (key) => JSON.parse(window.localStorage.getItem(key));
  assert.equal(window.localStorage.getItem('mixdog.desktop.time-format.v1'), '24h');
  assert.equal(window.localStorage.getItem('mixdog.desktop.side-panel-position.v1'), 'bottom');
  assert.equal(window.localStorage.getItem('mixdog.desktop.chat-text-size.v1'), 'extra-large');
  assert.deepEqual(
    { ...stored('mixdog.desktop.fonts.v1') },
    { ui: '', mono: '', uiScale: 1.15, codeSize: 16, ligatures: false }
  );
  const status = await prefs.read();
  assert.deepEqual(
    [
      status.timeFormat,
      status.sidePanelPosition,
      status.uiScale,
      status.codeSize,
      status.codeLigatures,
      status.chatTextSize,
    ],
    ['24h', 'bottom', 1.15, 16, false, 'extra-large']
  );
  await prefs.write({ timeFormat: '12h', sidePanelPosition: 'auto', uiScale: 0.85, codeSize: 10, codeLigatures: true });
  const edges = await prefs.read();
  assert.deepEqual(
    [edges.timeFormat, edges.sidePanelPosition, edges.uiScale, edges.codeSize, edges.codeLigatures],
    ['12h', 'auto', 0.85, 10, true]
  );
  await prefs.write({ uiScale: 1.2, codeSize: 20 });
  assert.equal((await prefs.read()).uiScale, 1.2);
  for (const [bad, message] of [
    [{ timeFormat: '36h' }, /system, 12h or 24h/],
    [{ sidePanelPosition: 'left' }, /right, bottom or auto/],
    [{ chatTextSize: 'huge' }, /chatTextSize/],
    [{ uiScale: 1.25 }, /uiScale/],
    [{ uiScale: 0.8 }, /uiScale/],
    [{ uiScale: 1.07 }, /uiScale/],
    [{ uiScale: '1' }, /uiScale/],
    [{ codeSize: 9 }, /codeSize/],
    [{ codeSize: 21 }, /codeSize/],
    [{ codeSize: 12.5 }, /codeSize/],
    [{ codeLigatures: 'off' }, /true or false/],
  ]) {
    await assert.rejects(prefs.write({ chatTextSize: 'small', ...bad }), message);
  }
  const after = await prefs.read();
  assert.equal(after.chatTextSize, 'extra-large', 'a rejected request changes nothing');
  assert.equal(after.uiScale, 1.2);
  assert.equal(after.codeSize, 20);
});

function petFixture({ created = true } = {}) {
  let config = {
    enabled: true,
    pinned: true,
    pinnedHere: false,
    onScreen: false,
    keepAbove: false,
    collapsed: false,
    autoAdvance: true,
    autoClose: true,
    scale: 100,
  };
  const calls = [];
  const exclusive = ['pinned', 'pinnedHere', 'onScreen'];
  const api = {
    getDesktopPetConfig: async () => ({ ...config }),
    setDesktopPetEnabled: async (enabled) => {
      calls.push(['enabled', enabled]);
      config = { ...config, enabled };
      return { ...config };
    },
    setDesktopPetOption: async (name, value) => {
      calls.push([name, value]);
      config = {
        ...config,
        ...(value && exclusive.includes(name) ? { pinned: false, pinnedHere: false, onScreen: false } : {}),
      };
      config[name] = value;
      return { ...config };
    },
    setDesktopPetScale: async (scale) => {
      calls.push(['scale', scale]);
      config = { ...config, scale };
      return { ...config };
    },
    invokeCapability: async ({ capability }) => {
      if (capability === 'getVoiceStatus') return { value: { installed: false, enabled: false } };
      assert.equal(capability, 'getLeadStatus');
      return { value: { created } };
    },
    readSettings: async () => ({}),
    readActivityRailPins: async () => null,
  };
  const run = (args) => executeSetupDesktopAction(args, api, {}, 'session');
  const status = async () => (await run({ action: 'status', domain: 'desktop' })).botOverlay;
  return { api, calls, run, status };
}

test('botOverlay applies every field through the pet API and status desktop reads it back', async () => {
  const { run, calls, status } = petFixture();
  const start = await status();
  assert.deepEqual(start, {
    enabled: true,
    position: 'pinned',
    keepAbove: false,
    collapsed: false,
    autoAdvance: true,
    autoClose: true,
    scale: 100,
    scales: DESKTOP_PET_SCALES,
    representativeBot: true,
  });
  const result = await run({
    action: 'set_desktop_settings',
    desktop: {
      botOverlay: {
        enabled: false,
        position: 'onScreen',
        keepAbove: true,
        collapsed: true,
        autoAdvance: false,
        autoClose: false,
        scale: 150,
      },
    },
  });
  assert.equal(result.saved, true);
  assert.equal(result.scope, 'desktop-host');
  const expected = {
    enabled: false,
    position: 'onScreen',
    keepAbove: true,
    collapsed: true,
    autoAdvance: false,
    autoClose: false,
    scale: 150,
  };
  assert.deepEqual(result.botOverlay, expected);
  const after = await status();
  assert.deepEqual(
    { ...after, scales: undefined, representativeBot: undefined },
    { ...expected, scales: undefined, representativeBot: undefined }
  );
  // Position mirrors the Settings select: a placement turns itself on; "free" turns the current one off.
  calls.length = 0;
  await run({ action: 'set_desktop_settings', desktop: { botOverlay: { position: 'free' } } });
  assert.deepEqual(calls, [['onScreen', false]]);
  assert.equal((await status()).position, 'free');
  calls.length = 0;
  await run({ action: 'set_desktop_settings', desktop: { botOverlay: { position: 'pinnedHere' } } });
  await run({ action: 'set_desktop_settings', desktop: { botOverlay: { position: 'pinnedHere', enabled: true } } });
  assert.deepEqual(calls, [
    ['pinnedHere', true],
    ['enabled', true],
  ]);
  assert.equal((await status()).position, 'pinnedHere');
  assert.equal((await status()).enabled, true);
  await run({ action: 'set_desktop_settings', desktop: { botOverlay: { position: 'pinned' } } });
  assert.equal((await status()).position, 'pinned');
});

test('botOverlay failing after earlier writes reports them as saved with the state in effect', async () => {
  const { api, run, status } = petFixture();
  const setOption = api.setDesktopPetOption;
  api.setDesktopPetOption = async (name, value) => {
    if (name === 'collapsed') throw new Error('pet window gone');
    return setOption(name, value);
  };
  await assert.rejects(
    run({
      action: 'set_desktop_settings',
      desktop: { botOverlay: { enabled: false, keepAbove: true, collapsed: true, scale: 80 } },
    }),
    (error) => {
      assert.match(
        error.message,
        /Could not save botOverlay\. Already saved: botOverlay\.enabled, botOverlay\.keepAbove\./
      );
      assert.match(error.message, /pet window gone/);
      assert.match(
        error.message,
        /Current botOverlay: .*"enabled":false.*"keepAbove":true.*"collapsed":false.*"scale":100/
      );
      return true;
    }
  );
  const after = await status();
  assert.equal(after.enabled, false);
  assert.equal(after.keepAbove, true);
  assert.equal(after.scale, 100, 'later subfields are not attempted');
});

test('time format: a change reports requiresReload without reloading; a time consumer shows the new format', async (t) => {
  const { installTestDom } = await import('./test-support/test-dom.mjs');
  installTestDom(t, { actEnvironment: false, expose: ['MutationObserver'] });
  const { desktopSetupPreferences } = await import('./use-setup-desktop-request.ts');
  let reloads = 0;
  globalThis.window.location = { reload: () => reloads++ };
  const { clockText } = await import('./time-format-preference.ts');
  const prefs = desktopSetupPreferences({});
  const afternoon = new Date(2024, 0, 2, 15, 5);
  await prefs.write({ timeFormat: 'system' });
  assert.equal(clockText(afternoon, 'en-US'), '15:05');
  const changed = await prefs.write({ timeFormat: '12h' });
  assert.equal(changed.requiresReload, true);
  assert.equal(changed.reloadsAfterReceipt, undefined);
  assert.match(changed.appliesTo, /already-shown times update.*after the window reloads/);
  assert.match(clockText(afternoon, 'en-US'), /^0?3:05\s?PM$/);
  const same = await prefs.write({ timeFormat: '12h' });
  assert.equal(same.requiresReload, false);
  assert.equal(reloads, 0, 'no reload is performed');
});

test('botOverlay rejects bad values without writing and refuses to enable without a representative bot', async () => {
  const { run, calls, status } = petFixture();
  for (const [botOverlay, message] of [
    [{ position: 'left' }, /position must be/],
    [{ scale: 105 }, /scale must be one of/],
    [{ scale: '100' }, /scale must be one of/],
    [{ keepAbove: 'yes' }, /keepAbove must be true or false/],
    [{ pinned: true }, /Unsupported botOverlay field/],
    [{}, /at least one field/],
  ]) {
    await assert.rejects(run({ action: 'set_desktop_settings', desktop: { botOverlay } }), message);
  }
  assert.deepEqual(calls, []);
  const missing = petFixture({ created: false });
  assert.equal((await missing.status()).representativeBot, false);
  await assert.rejects(
    missing.run({ action: 'set_desktop_settings', desktop: { botOverlay: { enabled: true, scale: 80 } } }),
    /representative bot/
  );
  assert.deepEqual(missing.calls, [], 'a refused enable changes nothing');
  await missing.run({ action: 'set_desktop_settings', desktop: { botOverlay: { enabled: false } } });
  assert.deepEqual(missing.calls, [['enabled', false]]);
  assert.equal((await status()).enabled, true);
});

test('setup schema agrees with the Desktop stores for the new appearance and botOverlay fields', async () => {
  const { SETUP_TOOL_DEFS } = await import('../../../../src/session-runtime/setup-tool/tool-defs.mjs');
  const { CODE_SIZE_RANGE, UI_SCALE_RANGE } = await import('./appearance/font-settings.ts');
  const { CHAT_TEXT_SCALES } = await import('./chat-text-size-preference.ts');
  const { appearance, desktop } = SETUP_TOOL_DEFS[0].inputSchema.properties;
  assert.deepEqual(desktop.properties.botOverlay.properties.scale.enum, [...DESKTOP_PET_SCALES]);
  assert.equal(appearance.properties.uiScale.minimum, UI_SCALE_RANGE.min);
  assert.equal(appearance.properties.uiScale.maximum, UI_SCALE_RANGE.max);
  assert.equal(appearance.properties.codeSize.minimum, CODE_SIZE_RANGE.min);
  assert.equal(appearance.properties.codeSize.maximum, CODE_SIZE_RANGE.max);
  assert.deepEqual(appearance.properties.chatTextSize.enum, Object.keys(CHAT_TEXT_SCALES));
});

test('appearance fonts, skin transparency and an imported color theme write, read back and reject bad values', async (t) => {
  const { installTestDom } = await import('./test-support/test-dom.mjs');
  installTestDom(t, { actEnvironment: false, expose: ['MutationObserver'] });
  const { desktopSetupPreferences } = await import('./use-setup-desktop-request.ts');
  const { importUserTheme } = await import('./appearance/user-theme.ts');
  const { THEME_SCHEMA_URL } = await import('./appearance/theme-file.ts');
  const imported = importUserTheme(
    JSON.stringify({ $schema: THEME_SCHEMA_URL, name: 'Harbor', roles: { background: '#0f1720', text: '#e6edf3' } })
  );
  assert.ok(imported.ok);
  const prefs = desktopSetupPreferences({});
  const start = await prefs.read();
  assert.equal(start.skinOuterTransparency, 50);
  assert.equal(start.skinMainTransparency, 50);
  assert.equal(start.uiFont, '');
  assert.equal(start.colorTheme, imported.id);
  assert.deepEqual(
    start.colorThemes.map((entry) => entry.value),
    ['builtin', imported.id]
  );
  const result = await prefs.write({
    uiFont: ' "Inter" ',
    codeFont: 'Fira Code',
    skinTransparency: 80,
    colorTheme: 'builtin',
  });
  assert.equal(result.saved, true);
  assert.equal(result.uiFont, 'Inter');
  assert.equal(result.codeFont, 'Fira Code');
  assert.equal(result.skinOuterTransparency, 80);
  assert.equal(result.skinMainTransparency, 80);
  assert.equal(result.colorTheme, 'builtin');
  const split = await prefs.write({ skinTransparency: 30, skinMainTransparency: 70 });
  assert.equal(split.skinOuterTransparency, 30, 'skinTransparency sets both, a slider field overrides its own');
  assert.equal(split.skinMainTransparency, 70);
  const outerOnly = await prefs.write({ skinOuterTransparency: 5 });
  assert.equal(outerOnly.skinOuterTransparency, 5);
  assert.equal(outerOnly.skinMainTransparency, 70, 'the other slider stays');
  await prefs.write({ skinTransparency: 80 });
  await prefs.write({ uiFont: '', colorTheme: imported.id });
  const status = await prefs.read();
  assert.equal(status.uiFont, '');
  assert.equal(status.codeFont, 'Fira Code');
  assert.equal(status.colorTheme, imported.id);
  await assert.rejects(prefs.write({ uiFont: 'Inter; color: red' }), /font family/);
  await assert.rejects(prefs.write({ codeFont: 'monospace' }), /font family/);
  await assert.rejects(prefs.write({ skinTransparency: 101 }), /0 to 100/);
  await assert.rejects(prefs.write({ skinTransparency: 12.5 }), /0 to 100/);
  await assert.rejects(prefs.write({ skinOuterTransparency: -1 }), /skinOuterTransparency.*0 to 100/);
  await assert.rejects(prefs.write({ skinMainTransparency: 100.5 }), /skinMainTransparency.*0 to 100/);
  await assert.rejects(prefs.write({ colorTheme: 'theme-missing' }), /Unknown color theme/);
  const after = await prefs.read();
  assert.equal(after.codeFont, 'Fira Code');
  assert.equal(after.skinOuterTransparency, 80);
  assert.equal(after.skinMainTransparency, 80);
  assert.equal(after.colorTheme, imported.id);
});
