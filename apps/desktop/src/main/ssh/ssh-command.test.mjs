import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  classifySshFailure,
  isLocalForwardBindFailure,
  parseSshTarget,
  SSH_COMMON_OPTIONS,
  sshExecArgs,
  sshTunnelArgs,
  SshTargetError,
  stderrTail,
  TunnelBackoff,
} from './ssh-command.ts';

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

test('exec arguments carry every mandatory option and put the target after --', () => {
  const target = parseSshTarget('alice@host:2222');
  const args = sshExecArgs(target, 'sh -c true');
  for (const option of [
    'BatchMode=yes',
    'ConnectTimeout=15',
    'ServerAliveInterval=10',
    'ServerAliveCountMax=3',
    'StrictHostKeyChecking=yes',
  ]) {
    const index = args.indexOf(option);
    assert.ok(index > 0 && args[index - 1] === '-o', option);
  }
  assert.deepEqual(args.slice(0, SSH_COMMON_OPTIONS.length), SSH_COMMON_OPTIONS);
  const separator = args.indexOf('--');
  assert.deepEqual(args.slice(separator), ['--', 'alice@host', 'sh -c true']);
  assert.ok(args.indexOf('-p') < separator && args[args.indexOf('-p') + 1] === '2222');
  assert.ok(args.includes('ClearAllForwardings=yes'));
});

test('tunnel arguments forward a loopback port and fail on forward errors', () => {
  const args = sshTunnelArgs(parseSshTarget('devbox'), 50123, 41001);
  const separator = args.indexOf('--');
  assert.deepEqual(args.slice(separator), ['--', 'devbox']);
  assert.ok(args.includes('-N'));
  assert.ok(args.includes('ExitOnForwardFailure=yes'));
  assert.equal(args[args.indexOf('-L') + 1], '127.0.0.1:50123:127.0.0.1:41001');
  assert.ok(!args.includes('-p'));
  assert.ok(args.includes('BatchMode=yes') && args.includes('ServerAliveCountMax=3'));
});

test('host key changes and refused logins are terminal; network trouble is not', () => {
  const changed = [
    '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@',
    '@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @',
    '@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@',
    'Host key for devbox has changed and you have requested strict checking.',
    'Host key verification failed.',
  ].join('\n');
  assert.equal(classifySshFailure(changed), 'terminal');
  assert.equal(classifySshFailure('alice@devbox: Permission denied (publickey,password).'), 'terminal');
  assert.equal(classifySshFailure('Received disconnect from 1.2.3.4: Too many authentication failures'), 'terminal');
  assert.equal(classifySshFailure('ssh: connect to host devbox port 22: Connection refused'), 'transient');
  assert.equal(classifySshFailure('ssh: connect to host devbox port 22: Connection timed out'), 'transient');
  assert.equal(classifySshFailure('client_loop: send disconnect: Connection reset'), 'transient');
  assert.equal(classifySshFailure('Timeout, server devbox not responding.'), 'transient');
  assert.equal(classifySshFailure(''), 'transient');
});

test('local bind failures are recognized so the next start picks another port', () => {
  assert.ok(
    isLocalForwardBindFailure(
      'bind [127.0.0.1]:50123: Address already in use\nchannel_setup_fwd_listener_tcpip: cannot listen to port: 50123\nCould not request local forwarding.'
    )
  );
  assert.ok(!isLocalForwardBindFailure('ssh: connect to host devbox port 22: Connection refused'));
});

test('stderr tail keeps the last lines verbatim', () => {
  const text = Array.from({ length: 20 }, (_, index) => `line ${index}`).join('\r\n');
  assert.equal(stderrTail(text, 3), 'line 17\nline 18\nline 19');
});

test('backoff walks 1,2,5,5,10,10,10,30,30 s, repeats the last step, and resets after 60 s healthy', () => {
  const backoff = new TunnelBackoff();
  const delays = Array.from({ length: 11 }, () => backoff.next(0) / 1_000);
  assert.deepEqual(delays, [1, 2, 5, 5, 10, 10, 10, 30, 30, 30, 30]);
  assert.equal(backoff.next(59_999), 30_000);
  assert.equal(backoff.next(60_000), 1_000);
  assert.equal(backoff.next(5_000), 2_000);
});
