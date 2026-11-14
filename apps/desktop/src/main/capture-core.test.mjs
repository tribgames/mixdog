import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { CAPTURE_PROJECT_FILES, CAPTURE_SETTINGS_VALUES, captureAgentConfig, captureShowcaseAnswers } from './capture-host.ts';
import { captureCoreEnvironment, captureFixtures, captureProfile, createCaptureRelay, startCaptureCore } from './capture-core.ts';

const scratch = () => mkdtempSync(join(import.meta.dirname, '.capture-core-test-'));

test('the capture profile lives inside the user data directory', () => {
  const profile = captureProfile(join(import.meta.dirname, 'userdata'));
  for (const path of Object.values(profile)) assert.ok(path.startsWith(profile.root), path);
  assert.equal(profile.config, join(profile.data, 'mixdog-config.json'));
});

test('the core environment moves every store into the profile and drops the parent MIXDOG names', () => {
  const profile = captureProfile(join(import.meta.dirname, 'userdata'));
  const env = captureCoreEnvironment(profile, {
    PATH: 'p',
    MIXDOGD_BIN: 'mixdogd',
    MIXDOG_HOME: 'C:\\installed',
    MIXDOG_DATA_DIR: 'C:\\installed\\data',
    MIXDOG_RELAY_URL: 'wss://relay.example',
    MIXDOG_SOMETHING_ELSE: '1',
  });
  assert.equal(env.PATH, 'p');
  assert.equal(env.MIXDOGD_BIN, 'mixdogd');
  assert.equal(env.MIXDOG_SOMETHING_ELSE, undefined);
  assert.equal(env.MIXDOG_RELAY_URL, 'off');
  for (const key of [
    'MIXDOG_HOME',
    'MIXDOG_CONFIG_DIR',
    'MIXDOG_DATA_DIR',
    'MIXDOG_RUNTIME_ROOT',
    'MIXDOG_BRIDGE_DISCOVERY_DIR',
    'MIXDOG_PROJECTS_FILE',
    'MIXDOG_USER_DATA_BACKUP_ROOT',
    'MIXDOG_DESKTOP_USER_DATA',
  ]) {
    assert.ok(env[key].startsWith(profile.root), `${key} = ${env[key]}`);
  }
});

test('the agent config carries the fixture settings, the Lead route and a finished onboarding', () => {
  const config = captureAgentConfig({ p: { type: 'custom' } }, { provider: 'p', model: 'm' }, new Date('2026-01-02T03:04:05Z'));
  assert.deepEqual(config.agents, { lead: { provider: 'p', model: 'm' } });
  assert.equal(config.heartbeat, CAPTURE_SETTINGS_VALUES.getHeartbeatSettings.heartbeat);
  assert.equal(config.heartbeatIntervalMinutes, 60);
  assert.equal(config.reactions, true);
  assert.equal(config.aiSessionTitles, false);
  assert.equal(config.promptCacheWarming, false);
  assert.deepEqual(config.recap, { enabled: true });
  assert.equal(config.onboarding.completed, true);
  assert.equal(config.onboarding.completedAt, '2026-01-02T03:04:05.000Z');
  assert.equal(config.developer.allowAllActions, true);
});

test('the showcase script is three calls, then prose and a running command, on files the project holds', () => {
  const answers = captureShowcaseAnswers('C:\\cap\\project');
  assert.equal(answers.length, 2);
  assert.deepEqual(
    answers[0].calls.map((call) => call.name),
    ['bash', 'bash', 'edit']
  );
  assert.match(answers[1].text, /rerunning the suite/);
  assert.deepEqual(
    answers[1].calls.map((call) => call.name),
    ['bash']
  );
  const commands = [...answers[0].calls.slice(0, 2), ...answers[1].calls].map((call) => call.args.command);
  for (const command of commands) {
    const script = /^node "C:\/cap\/project\/(tools\/[a-z]+\.mjs)"$/.exec(command);
    assert.ok(script, command);
    assert.ok(Object.hasOwn(CAPTURE_PROJECT_FILES, script[1]), script[1]);
  }
  assert.equal(answers[0].calls[2].args.path, 'C:/cap/project/src/app.ts');
  assert.ok(CAPTURE_PROJECT_FILES['src/app.ts'].includes(answers[0].calls[2].args.old_string));
});

function fakeDependencies(events) {
  const queue = [];
  return {
    queue,
    dependencies: {
      bin: 'mixdogd-test',
      baseEnv: { MIXDOGD_BIN: 'mixdogd-test' },
      loadProvider: async () => ({
        startProvider: async () => ({
          baseURL: 'http://127.0.0.1:1',
          state: { queue },
          close: async () => events.push('provider closed'),
        }),
        providerConfig: (baseURL) => ({ agent: { providers: { custom: { baseURL } } } }),
        customProviderId: 'custom',
      }),
      resolveCore: (options) => {
        events.push(`resolve ${options.runtimeRoot}`);
        return async () => ({ url: 'ws://127.0.0.1:9/rpc', token: 'tok' });
      },
      openLink: async (_resolve, onScope) => {
        onScope(7);
        return { close: async () => events.push('link closed') };
      },
    },
  };
}

test('startCaptureCore seeds the profile, queues the showcase and closes what it opened', async () => {
  const userData = scratch();
  try {
    const events = [];
    const { queue, dependencies } = fakeDependencies(events);
    const core = await startCaptureCore(
      { userData, fixtures: { ...captureFixtures, now: () => new Date('2026-01-01T00:00:00Z') } },
      dependencies
    );
    assert.deepEqual(core.endpoint, { url: 'ws://127.0.0.1:9/rpc', token: 'tok' });
    assert.equal(core.windowScope(), 7);
    assert.equal(events[0], `resolve ${core.profile.runtime}`);
    const stored = JSON.parse(readFileSync(core.profile.config, 'utf8'));
    assert.equal(stored.agent.providers.custom.baseURL, 'http://127.0.0.1:1');
    assert.deepEqual(stored.agent.agents.lead, { provider: 'custom', model: 'smoke' });
    for (const relative of Object.keys(CAPTURE_PROJECT_FILES)) {
      assert.ok(existsSync(join(core.projectPath, relative)), relative);
    }
    core.queueShowcase();
    assert.equal(queue.length, 2);
    await core.stop();
    assert.deepEqual(events.slice(-2), ['link closed', 'provider closed']);
  } finally {
    rmSync(userData, { recursive: true, force: true });
  }
});

test('startCaptureCore closes the provider when the core does not come up', async () => {
  const userData = scratch();
  try {
    const events = [];
    const { dependencies } = fakeDependencies(events);
    dependencies.resolveCore = () => async () => {
      throw new Error('core did not serve');
    };
    await assert.rejects(startCaptureCore({ userData }, dependencies), /core did not serve/);
    assert.deepEqual(events, ['provider closed']);
  } finally {
    rmSync(userData, { recursive: true, force: true });
  }
});

test('startCaptureCore refuses to start without a core binary', async () => {
  await assert.rejects(startCaptureCore({ userData: 'unused' }, { baseEnv: {} }), /MIXDOGD_BIN/);
});

test('the capture relay opens the window port to the capture core under the main role', async () => {
  const opened = [];
  const posted = [];
  const socket = Object.assign(new EventEmitter(), { send() {}, close() {}, terminate() {} });
  const port = Object.assign(new EventEmitter(), { postMessage: (message) => posted.push(message), start() {}, close() {} });
  const relay = createCaptureRelay(
    { endpoint: { url: 'ws://127.0.0.1:9/rpc', token: 'tok' }, windowScope: () => 3 },
    {
      createSocket: (url, headers) => {
        opened.push({ url, headers });
        queueMicrotask(() => socket.emit('open'));
        return socket;
      },
      createChannel: () => ({ port1: port, port2: {} }),
      log: () => {},
    }
  );
  const webContents = Object.assign(new EventEmitter(), {
    id: 5,
    postMessage: (channel, message) => posted.push({ channel, message }),
  });
  const { generation } = await relay.open(webContents);
  assert.equal(opened[0].url, 'ws://127.0.0.1:9/rpc');
  assert.equal(opened[0].headers.Authorization, 'Bearer tok');
  assert.equal(opened[0].headers['Mixdog-Window-Role'], 'main');
  assert.deepEqual(posted.at(-1).message, { generation, slot: 'primary', role: 'main', target: 'local' });
  relay.dispose();
});
