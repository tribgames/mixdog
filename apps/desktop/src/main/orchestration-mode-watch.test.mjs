import assert from 'node:assert/strict';
import test from 'node:test';
import { ORCHESTRATION_MODE_EVENT } from '../shared/orchestration-mode.ts';
import { watchConfiguredOrchestrationMode } from './orchestration-mode-watch.ts';

function fakeConfig(initial) {
  let value = initial;
  let listener = null;
  return {
    readConfig: () => value,
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
    listening: () => listener !== null,
  };
}

test('only a change of the configured orchestration default is published', () => {
  // The persisted shape: orchestration settings live under config.agent.
  const config = fakeConfig({ agent: { orchestrationMode: 'focused' }, theme: 'dark' });
  const published = [];
  const stop = watchConfiguredOrchestrationMode(config, (name, value) => published.push([name, value]));
  // Unrelated writes, and a rewrite of the same mode, tell no client anything.
  config.write({ agent: { orchestrationMode: 'focused' }, theme: 'light' });
  config.write({ agent: { orchestrationMode: 'focused', workflow: { active: 'x' } }, skills: ['a'] });
  assert.deepEqual(published, []);
  // A root-level key is not the setting.
  config.write({ agent: { orchestrationMode: 'focused' }, orchestrationMode: 'swarm' });
  assert.deepEqual(published, []);
  config.write({ agent: { orchestrationMode: 'swarm' }, theme: 'light' });
  assert.deepEqual(published, [[ORCHESTRATION_MODE_EVENT, { mode: 'swarm' }]]);
  // Defaults are stored as an absent key: removing it is a change back to the shipped default.
  config.write({ agent: {}, theme: 'light' });
  assert.deepEqual(published[1], [ORCHESTRATION_MODE_EVENT, { mode: 'balanced' }]);
  assert.equal(published.length, 2);
  // No agent section at all is the same fallback: no further event.
  config.write({ theme: 'dark' });
  assert.equal(published.length, 2);
  assert.ok(
    published.every(([name]) => name !== 'settings-changed'),
    'no settings-changed fan-out'
  );
  stop();
  assert.equal(config.listening(), false);
});

test('a config layer without change events publishes nothing', () => {
  const published = [];
  const stop = watchConfiguredOrchestrationMode({ readConfig: () => ({}) }, (...args) => published.push(args));
  assert.equal(stop, undefined);
  assert.deepEqual(published, []);
});
