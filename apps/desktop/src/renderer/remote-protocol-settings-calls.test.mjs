// The phone's settings, updater, rail-pin, notification and feedback calls on the settings adapter (remote-protocol-settings.ts):
// the argument checks with their texts come first, then one core request, then the value the relay frame carries. Inputs are inline.
import assert from 'node:assert/strict';
import test from 'node:test';
import { adapter } from './remote-protocol-settings.ts';

function scripted({ replies = {}, sections = {}, browserId } = {}) {
  const sent = [];
  const client = {
    call: async (method, params) => {
      sent.push({ method, params });
      const reply = replies[method];
      if (reply instanceof Error) throw reply;
      return (typeof reply === 'function' ? reply(params) : reply) ?? {};
    },
    store: { section: (name, key = null) => sections[`${name}:${key}`], subscribe: () => () => {} },
    on: () => () => {},
  };
  const host = { ctx: { browserId }, client: () => client, declareLane() {} };
  return { sent, call: async (name, args) => adapter.calls[name](args, host) };
}

const windowGone = Object.assign(new Error('rpc'), {
  detail: { kind: 'rpc', data: { reason: 'capabilityUnavailable', capability: 'desktopHost' } },
});

test("a setting toggle needs a boolean and writes the setting's own config path", async () => {
  const { sent, call } = scripted({ replies: { 'config/value/write': { config: {} } } });
  await assert.rejects(call('updateSetting', ['saveChatLogins', 'yes']), {
    name: 'TypeError',
    message: 'enabled must be a boolean.',
  });
  assert.deepEqual(sent, []);
  await call('updateSetting', ['saveChatLogins', true]);
  await call('updateSetting', ['autoClear', false]);
  assert.deepEqual(sent, [
    { method: 'config/value/write', params: { path: 'desktop.saveChatLogins', value: true, announce: 'desktop' } },
    { method: 'config/value/write', params: { path: 'agent.autoClear.enabled', value: false, announce: 'desktop' } },
  ]);
});

test('rail pins: a list of unsupported destinations is refused before any write; a valid one is written once and answered as saved', async () => {
  const { sent, call } = scripted({
    replies: { 'config/value/write': { values: [{ pins: ['sessions', 'agents'], revision: 4 }] } },
  });
  for (const bad of ['sessions', ['nowhere'], [1]]) {
    await assert.rejects(call('updateActivityRailPins', [bad]), {
      message: 'Activity rail pins must be an array of supported destinations.',
    });
  }
  assert.deepEqual(sent, []);
  assert.deepEqual(await call('updateActivityRailPins', [['sessions', 'agents', 'sessions']]), {
    pins: ['sessions', 'agents'],
    revision: 4,
  });
  assert.deepEqual(sent, [
    {
      method: 'config/value/write',
      params: { path: 'desktop.activityRailPins', value: ['sessions', 'agents', 'sessions'] },
    },
  ]);
  const unsaved = scripted({ replies: { 'config/value/write': { values: [] } } });
  await assert.rejects(unsaved.call('updateActivityRailPins', [['sessions']]), {
    message: 'The config write did not return valid activity rail pins.',
  });
});

test('the saved rail pins are read from the held desktop config', async () => {
  const { call } = scripted({
    sections: { 'config:desktop': { value: { activityRailPins: { pins: ['skills'], revision: 2 } } } },
  });
  assert.deepEqual(await call('readActivityRailPins', []), { pins: ['skills'], revision: 2 });
});

test('a paired phone reads and saves notification preferences using the limited roster', async () => {
  const notifications = { migratedAt: 10, devices: {} };
  const { sent, call } = scripted({
    browserId: 'phone',
    sections: { 'config:notifications': { value: notifications } },
    replies: {
      'remoteAccess/state': {
        settings: { name: 'Desk' },
        clients: [
          {
            id: 'phone',
            name: 'Phone · Mixdog App',
            platform: 'Android',
            browser: 'Mixdog App',
            alias: 'Pocket',
            createdAt: 20,
            online: true,
          },
        ],
        pushRegistered: ['phone'],
      },
      'notify/state': { supported: true, notifications },
      'config/value/write': ({ value }) => {
        notifications.devices.phone = value;
      },
    },
  });

  const before = await call('getNotificationPreferences', []);
  assert.equal(before.currentDeviceId, 'phone');
  assert.deepEqual(before.devices, [
    { id: 'pc', name: 'Desk', kind: 'pc', online: true, canNotify: true },
    { id: 'phone', name: 'Pocket', kind: 'phone-app', online: true, canNotify: true },
  ]);
  assert.equal(before.preferences.phone.scope, 'bots');
  const after = await call('setNotificationPreferences', ['phone', { scope: 'all' }]);
  assert.deepEqual(
    sent.filter(({ method }) => method === 'config/value/write'),
    [
      {
        method: 'config/value/write',
        params: { path: 'notifications.devices.phone', value: { scope: 'all' }, mode: 'mergePatchBots' },
      },
    ]
  );
  assert.equal(after.preferences.phone.scope, 'all');
});

test("the window's display preferences and updater state are the held sections, or the window did not answer", async () => {
  const none = scripted();
  await assert.rejects(none.call('readHostDisplayPreferences', []), {
    message: 'The desktop app did not answer the remote request.',
  });
  await assert.rejects(none.call('getUpdaterState', []), {
    message: 'The desktop app did not answer the remote request.',
  });
  const held = scripted({ sections: { 'update:null': { value: { status: 'idle' } } } });
  assert.deepEqual(await held.call('getUpdaterState', []), { status: 'idle' });
});

test('update commands go to the core as check or install, and install is confirmed only by a literal true', async () => {
  const { sent, call } = scripted();
  await call('checkForDesktopUpdate', []);
  await call('showDesktopUpdate', [true]);
  await call('showDesktopUpdate', ['true']);
  assert.deepEqual(
    sent.map((s) => s.params),
    [{ action: 'check' }, { action: 'install', confirmed: true }, { action: 'install', confirmed: false }]
  );
});

test('a request the window did not answer reads as the desktop not answering, other failures keep their text', async () => {
  const { call } = scripted({ replies: { 'update/desktop/command': windowGone } });
  await assert.rejects(call('checkForDesktopUpdate', []), {
    message: 'The desktop app did not answer the remote request.',
  });
});

test('feedback is checked before it is posted', async () => {
  const { sent, call } = scripted();
  await assert.rejects(call('submitFeedback', [null]), { name: 'TypeError', message: 'Feedback is invalid.' });
  assert.deepEqual(sent, []);
});

test('provider-model changes name their origin, and the answer is null', async () => {
  const { sent, call } = scripted();
  await assert.rejects(call('notifyProviderModelsChanged', ['  ']), {
    name: 'TypeError',
    message: 'origin is invalid.',
  });
  await assert.rejects(call('notifyProviderModelsChanged', [5]), {
    name: 'TypeError',
    message: 'origin must be a string.',
  });
  assert.equal(await call('notifyProviderModelsChanged', [' window-1 ']), null);
  assert.deepEqual(sent, [{ method: 'ui/providerModels/announce', params: { origin: 'window-1' } }]);
});

test("the core's settings and provider-model announcements reach the phone's listeners", () => {
  const seen = [];
  const listeners = {
    settingsChangedListeners: 'S',
    providerModelsListeners: 'P',
    updaterListeners: 'U',
    activityRailPinsListeners: 'R',
  };
  let handler;
  const client = {
    store: { section: () => undefined, appFeed: () => undefined, subscribe: () => () => {} },
    on: (fn) => ((handler = fn), () => {}),
  };
  const host = {
    ctx: { ...listeners, fanOut: (list, value) => seen.push([list, value]) },
    client: () => client,
    onClient: (wire) => (wire(client), () => {}),
  };
  adapter.install(host);
  handler({ type: 'notification', notification: { method: 'ui/providerModels/changed', params: { origin: 'w1' } } });
  handler({ type: 'notification', notification: { method: 'ui/unrelated', params: {} } });
  assert.deepEqual(
    seen.map(([list]) => list),
    ['P']
  );
});

test('a connected phone follows only changes to the configured orchestration default', async () => {
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const seen = [];
  const listeners = new Set([(value) => seen.push(value)]);
  let agent = { orchestrationMode: 'focused' };
  const subscribers = new Set();
  const onChange = (change) => {
    for (const subscriber of subscribers) subscriber(change);
  };
  const client = {
    store: {
      appFeed: () => ({ id: 'app', epoch: 'e1', seq: 1 }),
      section: (section, key) => (section === 'config' && key === 'agent' ? { value: agent } : undefined),
      subscribe: (listener) => (subscribers.add(listener), () => subscribers.delete(listener)),
    },
    on: () => () => {},
  };
  const stop = adapter.install({
    ctx: {
      orchestrationModeListeners: listeners,
      fanOut: (set, value) => {
        for (const listener of set) listener(value);
      },
    },
    onClient: (wire) => (wire(client), () => {}),
  });
  const updateAgent = async (next) => {
    agent = next;
    onChange({ type: 'section', section: 'config', key: 'agent' });
    await settle();
  };
  onChange({ type: 'thread', threadId: 's1' });
  onChange({ type: 'section', section: 'config', key: 'desktop' });
  await settle();
  await updateAgent({ orchestrationMode: 'focused', compaction: {} });
  await updateAgent({ orchestrationMode: 'swarm' });
  await updateAgent({});
  assert.deepEqual(seen, [{ mode: 'swarm' }, { mode: 'balanced' }]);
  stop();
});

test('the phone pages a stubbed config subtree it reads (settings, pins, conversation overrides) and nothing else', async () => {
  const { sent, call } = scripted({
    sections: {
      'config:desktop': { value: null },
      'config:agent': { value: {} },
      'config:notifications': { value: null },
    },
    replies: {
      'config/read': ({ keys: _keys }) => ({
        config: {
          desktop: { keepAwake: false, activityRailPins: { pins: ['skills'], revision: 2 } },
          notifications: {},
        },
      }),
    },
  });
  assert.equal((await call('readSettings', [])).keepAwake, false);
  assert.deepEqual(await call('readActivityRailPins', []), { pins: ['skills'], revision: 2 });
  assert.deepEqual(await call('listConversationNotifications', []), []);
  assert.deepEqual(
    sent.map((s) => s.params.keys),
    [['desktop'], ['desktop'], ['notifications']]
  );
});

test('a live change of a stubbed agent or desktop subtree is paged, and a read a newer change superseded is discarded', async () => {
  const seen = [];
  const pinsSeen = [];
  const subscribers = new Set();
  const answers = [];
  const agent = null;
  const client = {
    store: {
      appFeed: () => ({ id: 'app', epoch: 'e1', seq: 1 }),
      section: (section, key) => (section === 'config' ? { value: key === 'agent' ? agent : null } : undefined),
      subscribe: (listener) => (subscribers.add(listener), () => subscribers.delete(listener)),
    },
    call: (_method, params) => new Promise((resolve) => answers.push({ params, resolve })),
    on: () => () => {},
  };
  const fan = (set, value) => {
    for (const listener of set) listener(value);
  };
  const stop = adapter.install({
    ctx: {
      orchestrationModeListeners: new Set([(v) => seen.push(v)]),
      activityRailPinsListeners: new Set([(v) => pinsSeen.push(v)]),
      fanOut: fan,
    },
    onClient: (wire) => (wire(client), () => {}),
  });
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  // Startup reads: pins (desktop stub) and the mode (agent stub).
  answers.splice(0).forEach(({ params, resolve }) =>
    resolve({
      config:
        params.keys[0] === 'agent'
          ? { agent: { orchestrationMode: 'focused' } }
          : { desktop: { activityRailPins: { pins: ['sessions'], revision: 1 } } },
    })
  );
  await settle();
  const change = (key) => subscribers.forEach((s) => s({ type: 'section', section: 'config', key }));
  change('agent');
  change('agent');
  change('desktop');
  const [first, second, pins] = answers.splice(0);
  assert.deepEqual([first.params.keys, second.params.keys, pins.params.keys], [['agent'], ['agent'], ['desktop']]);
  second.resolve({ config: { agent: { orchestrationMode: 'swarm' } } });
  first.resolve({ config: { agent: { orchestrationMode: 'focused' } } });
  pins.resolve({ config: { desktop: { activityRailPins: { pins: ['sessions', 'agents'], revision: 2 } } } });
  await settle();
  assert.deepEqual(seen, [{ mode: 'swarm' }]);
  assert.deepEqual(pinsSeen, [{ pins: ['sessions', 'agents'], revision: 2 }]);
  stop();
});
test('a live mode change that supersedes the initial paged read of a stubbed agent subtree is still published', async () => {
  const seen = [];
  const subscribers = new Set();
  const answers = [];
  const client = {
    store: {
      appFeed: () => ({ id: 'app', epoch: 'e1', seq: 1 }),
      section: (section, key) => (section === 'config' && key === 'agent' ? { value: null } : undefined),
      subscribe: (listener) => (subscribers.add(listener), () => subscribers.delete(listener)),
    },
    call: () => new Promise((resolve) => answers.push(resolve)),
    on: () => () => {},
  };
  const stop = adapter.install({
    ctx: {
      orchestrationModeListeners: new Set([(v) => seen.push(v)]),
      fanOut: (set, value) => {
        for (const l of set) l(value);
      },
    },
    onClient: (wire) => (wire(client), () => {}),
  });
  subscribers.forEach((s) => s({ type: 'section', section: 'config', key: 'agent' }));
  const [initial, live] = answers;
  live({ config: { agent: { orchestrationMode: 'swarm' } } });
  initial({ config: { agent: { orchestrationMode: 'focused' } } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(seen, [{ mode: 'swarm' }]);
  stop();
});
