// createSettingsApi against a fake core connection: the method and params of each key equal what the main process sent for the
// same IPC call (main/ipc-window-settings.ts, ipc-notifications.ts, ipc-sessions.ts, ipc-file-dialogs.ts through the operation
// lane), the replies keep the IPC handlers' shapes, and the desktop events come from the announcements and the held sections.
import assert from 'node:assert/strict';
import test from 'node:test';

import { desktopSettingsFromConfig } from '../../shared/desktop-settings.ts';
import { NOTIFICATION_PC_DEVICE_ID } from '../../shared/contract-notifications.ts';
import { createSettingsApi } from './api-settings.ts';

const flush = async () => {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

function world({ replies = {}, entries = [] } = {}) {
  const sent = [];
  const events = new Set();
  const stores = new Set();
  const held = [...entries];
  const connection = {
    call: async (method, params) => {
      sent.push({ method, params });
      const reply = replies[method];
      return typeof reply === 'function' ? reply(params) : reply;
    },
    notify() {},
    attach: () => () => undefined,
    watchFiles: async () => undefined,
    unwatchFiles: async () => undefined,
    snapshot: () => ({ status: 'ready', entries: held }),
    whenSynced: async () => undefined,
    onEvent: (listener) => (events.add(listener), () => events.delete(listener)),
    onStoreChange: (listener) => (stores.add(listener), () => stores.delete(listener)),
    client: () => ({ store: {} }),
  };
  const ctx = { connection, window: () => undefined, pcClient: () => null, call: connection.call, setSender() {} };
  const set = (section, key, value, type = 'section') => {
    const at = held.findIndex((entry) => entry.section === section && entry.key === key);
    const entry = { section, key, revision: 1, value };
    if (at < 0) held.push(entry);
    else held[at] = entry;
    for (const listener of [...stores]) listener({ type, section, key });
  };
  const notify = (method, params) => {
    for (const listener of [...events]) listener({ type: 'notification', notification: { method, params } });
  };
  return { api: createSettingsApi(ctx), sent, set, notify, held, listeners: { events, stores } };
}

const entry = (section, key, value) => ({ section, key, revision: 1, value });
const rpc = (data) =>
  Object.assign(new Error(`-32600 ${data.reason}`), { name: 'ClientError', detail: { kind: 'rpc', code: -32600, reason: data.reason, message: data.reason, data } });

test('section_reads_send_nothing', async () => {
  const { api, sent } = world({
    entries: [
      entry('config', 'desktop', { activityRailPins: { pins: ['sessions'], revision: 3 }, editor: { markdownDefaultView: 'source' } }),
      entry('config', 'agent', {}),
      entry('config', 'notifications', undefined),
    ],
  });
  assert.deepEqual(await api.readSettings(), desktopSettingsFromConfig({ agent: {}, desktop: { activityRailPins: { pins: ['sessions'], revision: 3 }, editor: { markdownDefaultView: 'source' } } }));
  assert.deepEqual(await api.readActivityRailPins(), { pins: ['sessions'], revision: 3 });
  assert.equal(typeof (await api.readMarkdownDefaultView()), 'string');
  assert.deepEqual(await api.listConversationNotifications(), []);
  assert.deepEqual(sent, []);
});

test('desktop_setting_writes_announce_desktop_and_read_back_the_saved_config', async () => {
  const saved = { agent: { autoClear: { enabled: true } }, desktop: {} };
  const { api, sent } = world({ replies: { 'config/value/write': { values: [true] }, 'config/read': { config: saved } } });
  assert.deepEqual(await api.updateSetting('autoClear', true), desktopSettingsFromConfig(saved));
  assert.deepEqual(sent, [
    { method: 'config/value/write', params: { path: 'agent.autoClear.enabled', value: true, announce: 'desktop' } },
    { method: 'config/read', params: { keys: ['agent', 'desktop'] } },
  ]);
  sent.length = 0;
  await api.setNotificationVolume(40);
  await api.setSessionRetention('sessionAutoArchiveDays', 30);
  await api.setBrowserPermissions({ defaults: {}, sites: [] });
  assert.deepEqual(
    sent.filter((call) => call.method === 'config/value/write').map((call) => [call.params.path, call.params.announce]),
    [
      ['desktop.notificationVolume', 'desktop'],
      ['desktop.sessionAutoArchiveDays', 'desktop'],
      ['desktop.browserPermissions', 'desktop'],
    ]
  );
  assert.equal(sent[0].params.value, 40);
  assert.equal(sent[2].params.value, 30);
});

test('rail_pins_markdown_view_and_conversation_overrides_write_one_config_key', async () => {
  const { api, sent } = world({
    replies: { 'config/value/write': (params) => ({ values: [params.path === 'desktop.activityRailPins' ? { pins: ['sessions'], revision: 4 } : params.value] }) },
  });
  assert.deepEqual(await api.updateActivityRailPins(['sessions'], true), { pins: ['sessions'], revision: 4 });
  assert.deepEqual(sent[0], { method: 'config/value/write', params: { path: 'desktop.activityRailPins', value: ['sessions'], mode: 'initializeIfMissing' } });
  await api.updateActivityRailPins(['sessions']);
  assert.equal(sent[1].params.mode, undefined);
  assert.equal(await api.writeMarkdownDefaultView('source'), 'source');
  assert.deepEqual(sent[2], { method: 'config/value/write', params: { path: 'desktop.editor.markdownDefaultView', value: 'source' } });
  const target = { kind: 'session', sessionId: 's1' };
  await api.setConversationNotification(target, { muted: true });
  assert.deepEqual(sent[3], {
    method: 'config/value/write',
    params: { path: 'notifications.overrides', value: { target, setting: { muted: true } }, mode: 'setConversation' },
  });
});

test('provider_models_announcement_is_fire_and_forget', async () => {
  const { api, sent } = world({ replies: { 'ui/providerModels/announce': () => Promise.reject(new Error('down')) } });
  assert.equal(api.notifyProviderModelsChanged('settings'), undefined);
  await flush();
  assert.deepEqual(sent, [{ method: 'ui/providerModels/announce', params: { origin: 'settings' } }]);
});

test('notification_preferences_write_announces_notifications_and_answers_the_state', async () => {
  const { api, sent } = world({
    replies: {
      'remoteAccess/state': { settings: { name: '', defaultName: 'BENCH' }, clients: [] },
      'notify/state': { supported: true },
    },
  });
  const state = await api.setNotificationPreferences(NOTIFICATION_PC_DEVICE_ID, { enabled: false });
  assert.deepEqual(
    sent.map((call) => call.method),
    ['remoteAccess/state', 'notify/state', 'config/value/write', 'remoteAccess/state', 'notify/state']
  );
  assert.deepEqual(sent[2].params, {
    path: `notifications.devices.${NOTIFICATION_PC_DEVICE_ID}`,
    value: { enabled: false },
    mode: 'mergePatch',
    announce: 'notifications',
  });
  assert.equal(state.currentDeviceId, NOTIFICATION_PC_DEVICE_ID);
  assert.equal(state.devices[0].name, 'BENCH');
  assert.equal(state.devices[0].canNotify, true);
});

test('notification_preferences_read_the_state_and_a_test_notice_goes_to_the_core', async () => {
  const { api, sent } = world({
    replies: {
      'remoteAccess/state': { settings: { name: '', defaultName: 'BENCH' }, clients: [] },
      'notify/state': { supported: true },
      'notify/test': { ok: true },
    },
  });
  const state = await api.getNotificationPreferences();
  assert.equal(state.devices[0].name, 'BENCH');
  assert.deepEqual(sent.map((call) => call.method), ['remoteAccess/state', 'notify/state']);
  assert.deepEqual(await api.sendTestNotification(NOTIFICATION_PC_DEVICE_ID), { ok: true });
  assert.deepEqual(sent[2], { method: 'notify/test', params: { target: NOTIFICATION_PC_DEVICE_ID } });
});

test('system_fonts_are_the_families_the_core_lists', async () => {
  const { api, sent } = world({ replies: { 'desktop/fonts/list': { families: ['Inter', 'Mono'] } } });
  assert.deepEqual(await api.listSystemFonts(), ['Inter', 'Mono']);
  assert.deepEqual(sent, [{ method: 'desktop/fonts/list', params: {} }]);
});

test('notification_preferences_of_an_unpaired_device_write_nothing', async () => {
  const { api, sent } = world({ replies: { 'remoteAccess/state': { clients: [] }, 'notify/state': { supported: true } } });
  await assert.rejects(api.setNotificationPreferences('nobody', {}), /not paired/);
  assert.ok(!sent.some((call) => call.method === 'config/value/write'));
});

test('remote_access_calls_send_the_operation_params', async () => {
  const off = { relay: { clientUrl: '', token: '', clients: [] }, enabled: false };
  const { api, sent } = world({
    replies: {
      'remoteAccess/rotate': off,
      'remoteAccess/revokeClient': off,
      'remoteAccess/resolveClaim': true,
      'remoteAccess/pairCode': { code: '123456', expiresAt: 1 },
      'remoteAccess/setEnabled': { enabled: true, name: 'x', defaultName: 'y' },
    },
  });
  assert.equal((await api.rotateRemoteAccess()).enabled, false);
  assert.equal((await api.revokeRemoteAccessClient('c1')).enabled, false);
  assert.equal(await api.resolveRemoteClientClaim('k1', true), true);
  assert.deepEqual(await api.getRemotePairCode('renew'), { code: '123456', expiresAt: 1 });
  await api.getRemotePairCode('bogus');
  assert.deepEqual(await api.setRemoteAccessEnabled(true), { enabled: true, name: 'x', defaultName: 'y' });
  await api.setRemotePcName('Desk');
  await api.setRemotePcName(7);
  assert.equal(await api.setRemoteClientAlias('c1', 'Phone'), undefined);
  assert.deepEqual(
    sent.map((call) => [call.method, call.params]),
    [
      ['remoteAccess/rotate', {}],
      ['remoteAccess/revokeClient', { clientId: 'c1' }],
      ['remoteAccess/resolveClaim', { claimId: 'k1', approve: true }],
      ['remoteAccess/pairCode', { action: 'renew' }],
      ['remoteAccess/pairCode', { action: 'ensure' }],
      ['remoteAccess/setEnabled', { enabled: true }],
      ['remoteAccess/setName', { name: 'Desk' }],
      ['remoteAccess/setName', { name: '' }],
      ['remoteAccess/setClientAlias', { clientId: 'c1', alias: 'Phone' }],
    ]
  );
});

test('remote_access_reads_come_from_the_held_section', async () => {
  const disabled = {
    disabled: true,
    info: { relay: { clientUrl: '', token: '', clients: [] }, enabled: false },
    settings: { enabled: false, name: 'Desk', defaultName: 'BENCH' },
    claims: [{ claimId: 'k1' }],
  };
  const { api, sent } = world({ entries: [entry('remote', null, disabled)] });
  assert.equal((await api.getRemoteAccessInfo({ activate: true })).enabled, false);
  assert.deepEqual(await api.getRemoteAccessSettings(), disabled.settings);
  assert.deepEqual(await api.listRemoteClientClaims(), disabled.claims);
  assert.deepEqual(sent, []);
  const live = world({
    entries: [entry('remote', null, { disabled: false, info: { enabled: true, connected: true, relay: { clientUrl: 'https://relay.example/x', token: 't', clients: [] } } })],
    replies: { 'remoteAccess/activate': { disabled: false, info: { enabled: true, connected: true, relay: { clientUrl: 'https://relay.example/x', token: 't', clients: [] } } } },
  });
  const info = await live.api.getRemoteAccessInfo();
  assert.deepEqual(live.sent, [{ method: 'remoteAccess/activate', params: {} }]);
  assert.equal(info.enabled, true);
  assert.equal(info.relayConnectUrl, 'https://relay.example/connect');
});

test('a_core_failure_reaches_the_page_as_the_ipc_path_gave_it', async () => {
  const { api } = world({ replies: { 'remoteAccess/setName': () => Promise.reject(rpc({ reason: 'domainError', domain: 'remote', message: 'name is too long' })) } });
  await assert.rejects(api.setRemotePcName('x'), (error) => error instanceof Error && error.message === 'name is too long' && !error.detail);
});

test('announcements_reach_their_own_subscribers_and_stop_after_the_removal', () => {
  const { api, notify } = world();
  const settings = [];
  const models = [];
  const offSettings = api.subscribeSettingsChanged((change) => settings.push(change));
  const offModels = api.subscribeProviderModelsChanged((change) => models.push(change));
  notify('ui/settings/changed', { scope: 'desktop' });
  notify('ui/providerModels/changed', { origin: 'settings' });
  notify('ui/settings/changed', { scope: 'nonsense' });
  assert.deepEqual(settings, [{ scope: 'desktop' }]);
  assert.deepEqual(models, [{ origin: 'settings' }]);
  offSettings();
  offModels();
  notify('ui/settings/changed', { scope: 'agent' });
  assert.equal(settings.length, 1);
});

test('rail_pins_orchestration_and_turn_review_follow_the_held_sections', () => {
  const { api, set, listeners } = world({
    entries: [entry('config', 'desktop', { activityRailPins: { pins: ['sessions'], revision: 1 } }), entry('config', 'agent', {})],
  });
  const pins = [];
  const modes = [];
  let reviews = 0;
  const offPins = api.subscribeActivityRailPins((state) => pins.push(state));
  const offMode = api.subscribeOrchestrationModeChanged((change) => modes.push(change));
  const offReview = api.subscribeTurnReviewChanged(() => (reviews += 1));
  set('config', 'desktop', { activityRailPins: { pins: ['sessions'], revision: 1 }, other: 1 });
  set('config', 'desktop', { activityRailPins: { pins: ['agents'], revision: 2 } });
  assert.deepEqual(pins, [{ pins: ['agents'], revision: 2 }]);
  set('config', 'agent', { orchestrationMode: 'swarm' });
  set('config', 'agent', { orchestrationMode: 'swarm', x: 1 });
  set('config', 'agent', {});
  assert.deepEqual(modes, [{ mode: 'swarm' }, { mode: 'balanced' }]);
  set('reviewDiff', null, { revision: 1 });
  assert.equal(reviews, 1);
  offPins();
  offMode();
  offReview();
  assert.equal(listeners.stores.size, 0);
});

test('remote_settings_and_new_claims_follow_the_remote_section', async () => {
  const base = { settings: { enabled: true, name: 'a', defaultName: 'b' }, claims: [{ claimId: 'k1' }] };
  const { api, set } = world({ entries: [entry('remote', null, base)] });
  const settings = [];
  const claims = [];
  api.subscribeRemoteAccessSettings((value) => settings.push(value));
  api.subscribeRemoteClientClaim((claim) => claims.push(claim));
  await flush();
  assert.deepEqual([settings, claims], [[], []]);
  set('remote', null, { ...base, claims: [{ claimId: 'k1' }, { claimId: 'k2' }] });
  await flush();
  assert.deepEqual(claims, [{ claimId: 'k2' }]);
  assert.deepEqual(settings, []);
  set('remote', null, { settings: { enabled: false, name: 'a', defaultName: 'b' }, claims: [{ claimId: 'k2' }] });
  await flush();
  assert.deepEqual(settings, [{ enabled: false, name: 'a', defaultName: 'b' }]);
  assert.equal(claims.length, 1);
});
