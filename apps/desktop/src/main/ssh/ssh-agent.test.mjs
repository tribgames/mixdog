import assert from 'node:assert/strict';
import { test } from 'node:test';

import { detectSshAgent, parseServiceState, serviceIsDisabled } from './ssh-agent.ts';

const SC_RUNNING =
  'SERVICE_NAME: ssh-agent\n        TYPE               : 10  WIN32_OWN_PROCESS\n        STATE              : 4  RUNNING\n';
const SC_STOPPED = 'SERVICE_NAME: ssh-agent\n        STATE              : 1  STOPPED\n';
const SC_MISSING =
  '[SC] EnumQueryServicesStatus:OpenService FAILED 1060:\n\nThe specified service does not exist as an installed service.\n';
const qc = (type) => `SERVICE_NAME: ssh-agent\n        START_TYPE         : ${type}\n`;

/** Answers sc.exe and ssh-add like the OS; `add` is ssh-add -l's exit code. */
const tools =
  ({ query, config = qc('2   AUTO_START'), add = 0 }) =>
  async (command, args) => {
    if (command === 'sc.exe') return { code: 0, stdout: args[0] === 'query' ? query : config, stderr: '' };
    if (command === 'ssh-add') return { code: add, stdout: '', stderr: '' };
    throw new Error(`unexpected ${command}`);
  };

test('service output is read for state and start type', () => {
  assert.equal(parseServiceState(SC_RUNNING), 'running');
  assert.equal(parseServiceState(SC_STOPPED), 'stopped');
  assert.equal(parseServiceState(SC_MISSING), 'missing');
  assert.equal(parseServiceState('garbage'), 'unknown');
  assert.equal(serviceIsDisabled(qc('4   DISABLED')), true);
  assert.equal(serviceIsDisabled(qc('3   DEMAND_START')), false);
});

test('Windows: a stopped service is started, a disabled one is enabled first, a missing one has nothing to start', async () => {
  const stopped = await detectSshAgent(tools({ query: SC_STOPPED, config: qc('3   DEMAND_START') }), 'win32');
  assert.deepEqual(stopped, { state: 'stopped', command: 'Start-Service ssh-agent; ssh-add' });
  const disabled = await detectSshAgent(tools({ query: SC_STOPPED, config: qc('4   DISABLED') }), 'win32');
  assert.deepEqual(disabled, {
    state: 'disabled',
    command: 'Set-Service ssh-agent -StartupType Manual; Start-Service ssh-agent; ssh-add',
  });
  assert.deepEqual(await detectSshAgent(tools({ query: SC_MISSING }), 'win32'), { state: 'missing' });
});

test('Windows: a running agent is empty or holds keys', async () => {
  assert.deepEqual(await detectSshAgent(tools({ query: SC_RUNNING, add: 0 }), 'win32'), { state: 'running' });
  assert.deepEqual(await detectSshAgent(tools({ query: SC_RUNNING, add: 1 }), 'win32'), {
    state: 'empty',
    command: 'ssh-add',
  });
});

test('macOS/Linux: no agent socket, an unreachable one, an empty one and one with keys', async () => {
  const run = (add) => tools({ query: '', add });
  assert.deepEqual(await detectSshAgent(run(0), 'linux', {}), {
    state: 'missing',
    command: 'eval "$(ssh-agent -s)" && ssh-add',
  });
  const env = { SSH_AUTH_SOCK: '/tmp/agent.1' };
  assert.deepEqual((await detectSshAgent(run(2), 'darwin', env)).state, 'missing');
  assert.deepEqual(await detectSshAgent(run(1), 'darwin', env), { state: 'empty', command: 'ssh-add' });
  assert.deepEqual(await detectSshAgent(run(0), 'linux', env), { state: 'running' });
});

test('a machine without the tools reports an unknown state instead of failing', async () => {
  const none = async () => {
    throw new Error('not found');
  };
  assert.deepEqual(await detectSshAgent(none, 'linux', { SSH_AUTH_SOCK: '/x' }), { state: 'unknown' });
});
