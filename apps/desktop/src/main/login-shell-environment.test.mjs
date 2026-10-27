import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  extractLoginShellEnvironment,
  loginShellOverrides,
  readLoginShellEnvironment,
  withHomebrewPath,
} from './login-shell-environment.ts';

const MARK = '__MIXDOG_LOGIN_ENV__';

test('reads only the variables between the two marks', () => {
  const output = `rc banner\0${MARK}\0PATH=/opt/homebrew/bin:/usr/bin\0KEY=a=b\0\0${MARK}\0trailing noise`;
  assert.deepEqual(extractLoginShellEnvironment(output), {
    PATH: '/opt/homebrew/bin:/usr/bin',
    KEY: 'a=b',
  });
});

test('an unfinished dump is not an environment yet', () => {
  assert.equal(extractLoginShellEnvironment(`\0${MARK}\0PATH=/usr/bin\0`), null);
  assert.equal(extractLoginShellEnvironment('no marks at all'), null);
});

test('the shell wins except for probe, Electron, and launcher-set MIXDOG values', () => {
  const inherited = {
    PATH: '/usr/bin',
    HOME: '/Users/me',
    MIXDOG_GRAPH_BIN: '/app/native-tools/mixdog-graph',
    ELECTRON_RUN_AS_NODE: '1',
  };
  const shell = {
    PATH: '/opt/homebrew/bin:/usr/bin',
    HOME: '/Users/me',
    OPENAI_API_KEY: 'sk-test',
    MIXDOG_GRAPH_BIN: '/elsewhere/mixdog-graph',
    MIXDOG_HOME: '/Users/me/.mixdog-alt',
    ELECTRON_RUN_AS_NODE: '0',
    SHLVL: '2',
    PWD: '/Users/me',
    DISABLE_AUTO_UPDATE: 'true',
  };
  assert.deepEqual(loginShellOverrides(inherited, shell), {
    PATH: '/opt/homebrew/bin:/usr/bin',
    OPENAI_API_KEY: 'sk-test',
    MIXDOG_HOME: '/Users/me/.mixdog-alt',
  });
});

test('missing Homebrew directories that exist are appended after the shell order', () => {
  const installed = new Set(['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin']);
  assert.deepEqual(
    withHomebrewPath('/usr/local/bin:/usr/bin:/bin', (dir) => installed.has(dir)),
    {
      path: '/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin:/opt/homebrew/sbin',
      added: ['/opt/homebrew/bin', '/opt/homebrew/sbin'],
    }
  );
  assert.deepEqual(
    withHomebrewPath(undefined, () => false),
    { path: '', added: [] }
  );
});

test('the original PATH string is kept verbatim, empty components included', () => {
  const installed = (dir) => dir === '/opt/homebrew/bin';
  assert.deepEqual(withHomebrewPath(':/usr/bin::/bin:', installed), {
    path: ':/usr/bin::/bin::/opt/homebrew/bin',
    added: ['/opt/homebrew/bin'],
  });
  assert.deepEqual(
    withHomebrewPath('/usr/bin::/bin', () => false),
    { path: '/usr/bin::/bin', added: [] }
  );
  assert.deepEqual(withHomebrewPath('', installed), { path: '/opt/homebrew/bin', added: ['/opt/homebrew/bin'] });
});

test('Windows launches keep the inherited environment without spawning a shell', async () => {
  assert.deepEqual(await readLoginShellEnvironment({ platform: 'win32', shells: ['/bin/zsh'] }), {
    environment: null,
    failures: [],
  });
});

test('a shell that cannot start is recorded and the next candidate is tried', async () => {
  const missing = ['/nonexistent/mixdog-shell-a', '/nonexistent/mixdog-shell-b'];
  const result = await readLoginShellEnvironment({ platform: 'linux', shells: missing });
  assert.equal(result.environment, null);
  assert.deepEqual(
    result.failures.map((failure) => failure.shell),
    missing
  );
  for (const failure of result.failures) assert.match(failure.reason, /ENOENT/);
});
