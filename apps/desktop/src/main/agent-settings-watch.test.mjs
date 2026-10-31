import assert from 'node:assert/strict';
import test from 'node:test';
import { SETTINGS_CHANGED_EVENT } from '../shared/settings-changed.ts';
import { watchAgentSettings } from './agent-settings-watch.ts';

function fakeConfig(initial) {
  let value = initial;
  let tokens = {};
  let listener = null;
  return {
    readConfig: () => value,
    secretChangeTokens: () => ({ ...tokens }),
    subscribeConfigChange(next) {
      listener = next;
      return () => {
        listener = null;
      };
    },
    write(next) {
      value = next;
      listener?.();
    },
    saveKey(account, token) {
      tokens = { ...tokens, [account]: token };
      listener?.();
    },
    listening: () => listener !== null,
  };
}

test('a setting or stored key changed by any writer publishes one agent-scoped settings change', () => {
  const config = fakeConfig({ agent: { profile: { language: 'en' } }, desktop: { keepAwake: true } });
  const published = [];
  const stop = watchAgentSettings(config, (name, value) => published.push([name, value]));
  // A desktop-only write has its own owners and scope.
  config.write({ agent: { profile: { language: 'en' } }, desktop: { keepAwake: false } });
  assert.deepEqual(published, []);
  // The setup tool (or a hand edit) changes an agent setting.
  config.write({ agent: { profile: { language: 'ko' } }, desktop: { keepAwake: false } });
  assert.deepEqual(published, [[SETTINGS_CHANGED_EVENT, { scope: 'agent' }]]);
  // Rewriting identical content tells nobody anything.
  config.write({ agent: { profile: { language: 'ko' } }, desktop: { keepAwake: false } });
  assert.equal(published.length, 1);
  // A root-level setting and a keychain write count too.
  config.write({ agent: { profile: { language: 'ko' } }, outputStyle: 'detailed', desktop: { keepAwake: false } });
  config.saveKey('agent.openai.apiKey', 't1');
  assert.equal(published.length, 3);
  stop();
  assert.equal(config.listening(), false);
});

test('a config layer without change events publishes nothing', () => {
  const published = [];
  const stop = watchAgentSettings({ readConfig: () => ({}) }, (...args) => published.push(args));
  assert.equal(stop, undefined);
  assert.deepEqual(published, []);
});
