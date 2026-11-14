import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseSshTarget, SshTargetError } from './ssh-command.ts';

test('accepts host aliases, user@host, user@host:port and bracketed IPv6', () => {
  assert.deepEqual(parseSshTarget('devbox'), { destination: 'devbox', port: null, display: 'devbox' });
  assert.deepEqual(parseSshTarget(' alice@build.example.com '), {
    destination: 'alice@build.example.com',
    port: null,
    display: 'alice@build.example.com',
  });
  assert.deepEqual(parseSshTarget('alice@10.0.0.5:2222'), {
    destination: 'alice@10.0.0.5',
    port: 2222,
    display: 'alice@10.0.0.5:2222',
  });
  assert.deepEqual(parseSshTarget('host:22'), { destination: 'host', port: 22, display: 'host:22' });
  assert.deepEqual(parseSshTarget('bob@[fe80::1%eth0]:2200'), {
    destination: 'bob@fe80::1%eth0',
    port: 2200,
    display: 'bob@[fe80::1%eth0]:2200',
  });
  assert.deepEqual(parseSshTarget('fe80::1'), { destination: 'fe80::1', port: null, display: 'fe80::1' });
});

test('refuses option injection, control characters and shell metacharacters', () => {
  for (const bad of [
    '-oProxyCommand=calc',
    '--',
    '-p',
    'alice@-oProxyCommand=x',
    'host\n-oProxyCommand=x',
    'host\u0000',
    'host\t',
    'ho st',
    'host;rm -rf ~',
    '$(id)@host',
    'a`b`',
    "o'neil@host",
    '@host',
    'alice@',
    'host:0',
    'host:65536',
    'host:abc',
    'alice@[::1',
    '',
    '   ',
  ]) {
    assert.throws(() => parseSshTarget(bad), SshTargetError, JSON.stringify(bad));
  }
});
