import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';

import { parseSshTarget } from './ssh-command.ts';
import {
  DIAGNOSTICS_MAX_ENTRIES,
  appendDiagnostic,
  buildDiagnosticsText,
  describeArgv,
  diagnosticLines,
  diagnosticsKeyFor,
  readDiagnostics,
  redactSecrets,
  redactServer,
  resetDiagnostics,
  serverNames,
  traceSpawn,
} from './ssh-diagnostics.ts';

const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

test('secrets never enter the ring: tokens, passwords, bearer headers and long secret-looking values', () => {
  resetDiagnostics();
  appendDiagnostic('k', 'log', `daemon token=${TOKEN}`);
  appendDiagnostic('k', 'log', `MIXDOG_REMOTE_TOKEN=${TOKEN} node x`);
  appendDiagnostic('k', 'log', 'password: hunter2');
  appendDiagnostic('k', 'log', `Authorization: Bearer ${TOKEN}`);
  appendDiagnostic('k', 'log', `raw ${TOKEN}`);
  const joined = readDiagnostics('k')
    .map((entry) => entry.text)
    .join('\n');
  assert.equal(joined.includes(TOKEN), false);
  assert.equal(joined.includes('hunter2'), false);
  assert.match(joined, /<redacted>/);
  assert.equal(redactSecrets('plain text stays'), 'plain text stays');
});

test('the ring keeps the newest entries, per server', () => {
  resetDiagnostics();
  for (let index = 0; index < DIAGNOSTICS_MAX_ENTRIES + 25; index += 1) appendDiagnostic('a', 'log', `line ${index}`);
  appendDiagnostic('b', 'log', 'other server');
  const a = readDiagnostics('a');
  assert.equal(a.length, DIAGNOSTICS_MAX_ENTRIES);
  assert.equal(a[0].text, 'line 25');
  assert.deepEqual(
    readDiagnostics('b').map((entry) => entry.text),
    ['other server']
  );
  assert.match(diagnosticLines('b')[0], /^\d\d:\d\d:\d\d\.\d{3} log {4}other server$/);
});

test('a spawned ssh is recorded: argv without the long remote script, stderr, bootstrap results, exit and timing', () => {
  resetDiagnostics();
  let clock = 1_000;
  const child = fakeChild();
  traceSpawn(
    'C:\\Windows\\System32\\OpenSSH\\ssh.exe',
    ['-T', '--', 'ops@gate', `echo ${'ab cd '.repeat(1_000)}`],
    child,
    'k',
    () => clock
  );
  child.stderr.emit('data', Buffer.from('Warning: Permanently added\nconnect to host gate port 22: refused\n'));
  child.stdout.emit('data', Buffer.from('noise\nMIXDOG_RESULT {"ok":true}\nMIXDO'));
  child.stdout.emit('data', Buffer.from('G_ERROR partial'));
  clock = 1_450;
  child.emit('close', 255, null);
  const entries = readDiagnostics('k');
  assert.match(entries[0].text, /^ssh\.exe -T -- ops@gate echo (ab cd )*ab cd…\(\d+ chars\)$/);
  assert.equal(entries[0].kind, 'ssh');
  assert.deepEqual(
    entries.filter((entry) => entry.kind === 'stderr').map((entry) => entry.text),
    ['Warning: Permanently added', 'connect to host gate port 22: refused']
  );
  assert.deepEqual(
    entries.filter((entry) => entry.kind === 'result').map((entry) => entry.text),
    ['MIXDOG_RESULT {"ok":true}', 'MIXDOG_ERROR partial'],
    'a result line that was still open at exit is kept'
  );
  assert.equal(entries.at(-1).text, 'code 255 after 450 ms');
  assert.equal(describeArgv('ssh', ['-o', `Token=${TOKEN}`]).includes(TOKEN), false);
});

test('the tunnel’s starts and exits are logged, so restarts show', () => {
  resetDiagnostics();
  for (const code of [255, 255]) {
    const child = fakeChild();
    traceSpawn('ssh', ['-N', '-L', '1:2:3', '--', 'ops@gate'], child, 'k');
    child.emit('close', code, null);
  }
  const tunnel = readDiagnostics('k')
    .filter((entry) => entry.kind === 'tunnel')
    .map((entry) => entry.text.split(' ')[0]);
  assert.deepEqual(tunnel, ['start', 'exited', 'start', 'exited']);
});

test('copied text replaces the server’s user and host with <server>; short names only next to an @', () => {
  const target = parseSshTarget('deploy@vps.example.com:2202');
  const names = serverNames(target, ['203.0.113.7']);
  assert.equal(
    redactServer(
      'deploy@vps.example.com failed; VPS.example.com resolved to 203.0.113.7 as user deploy; port 2202',
      names
    ),
    '<server> failed; <server> resolved to <server> as user <server>; port 2202'
  );
  const short = parseSshTarget('me@box');
  assert.deepEqual(serverNames(short), ['me@box', 'box', 'me']);
  assert.equal(
    redactServer('me@box failed; login me@other and git@box; the box was on a boxed memo for me', serverNames(short)),
    '<server> failed; login <server>@other and git@<server>; the box was on a boxed memo for me',
    'a user or host of 3 characters or fewer is replaced as user@host, never as an ordinary word'
  );
  resetDiagnostics();
  appendDiagnostic(
    diagnosticsKeyFor(target),
    'stderr',
    `ssh: connect to host vps.example.com port 2202: Connection refused token=${TOKEN}`
  );
  const report = buildDiagnosticsText({
    key: diagnosticsKeyFor(target),
    target,
    appVersion: '1.2.3',
    sshVersion: 'OpenSSH_9.9',
    config: ['HostName 203.0.113.7', 'User deploy', 'Port 2202'],
    extraNames: ['203.0.113.7'],
  });
  assert.match(
    report,
    /^Mixdog SSH diagnostics\nApp: 1\.2\.3\nOS: \S+ .+\nssh: OpenSSH_9\.9\nConfig:\n {2}HostName <server>\n {2}User <server>\n {2}Port 2202\nLog \(last 100 lines\):\n/
  );
  assert.match(report, /connect to host <server> port 2202: Connection refused token=<redacted>/);
  for (const secret of ['vps.example.com', 'deploy', '203.0.113.7', TOKEN])
    assert.equal(report.includes(secret), false, secret);
});

test('the report holds only the last N lines', () => {
  resetDiagnostics();
  const target = parseSshTarget('ops@gateway');
  for (let index = 0; index < 150; index += 1) appendDiagnostic(diagnosticsKeyFor(target), 'log', `entry ${index}`);
  const report = buildDiagnosticsText({
    key: diagnosticsKeyFor(target),
    target,
    appVersion: 'v',
    sshVersion: '',
    config: [],
    lines: 5,
  });
  assert.equal(report.split('\n').filter((line) => /entry \d+/.test(line)).length, 5);
  assert.match(report, /entry 149/);
  assert.equal(report.includes('entry 144'), false);
});
