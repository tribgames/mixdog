import assert from 'node:assert/strict';
import { test } from 'node:test';

import { describeConnectFailure as describeWithCode, loginKeyCommands } from './connect-failure.ts';
import { RemoteBootstrapError } from './remote-bootstrap.ts';
import { parseSshTarget, SshError } from './ssh-command.ts';

const target = parseSshTarget('root@123.45.67.89');
/** The view without its `code`, which has its own test below. */
const describeConnectFailure = (...args) => {
  const { code, ...view } = describeWithCode(...args);
  return view;
};

test('a refused login becomes the login-key guidance, with the PowerShell variant on Windows', () => {
  const error = new SshError(
    'ssh failed:\nroot@x: Permission denied (publickey).',
    'terminal',
    'Permission denied (publickey).',
    255
  );
  assert.deepEqual(describeConnectFailure(error, target, 'linux'), {
    kind: 'auth',
    keygen: 'ssh-keygen -t ed25519',
    register: 'ssh-copy-id root@123.45.67.89',
  });
  const windows = describeConnectFailure(error, target, 'win32');
  assert.equal(windows.kind, 'auth');
  assert.match(
    windows.register,
    /^Get-Content "\$env:USERPROFILE\\\.ssh\\id_ed25519\.pub" \| ssh root@123\.45\.67\.89 "mkdir -p ~\/\.ssh && cat >> ~\/\.ssh\/authorized_keys"$/
  );
  assert.equal(loginKeyCommands(parseSshTarget('root@host:2202'), 'linux').register, 'ssh-copy-id -p 2202 root@host');
});

test('a changed host key blocks; a plain network failure is shown as it is', () => {
  const changed = new SshError('x', 'terminal', '@ WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED! @', 255);
  assert.deepEqual(describeConnectFailure(changed, target, 'linux'), { kind: 'host-key-changed' });
  const timeout = new SshError(
    'ssh root@123.45.67.89 failed:\nConnection timed out',
    'transient',
    'Connection timed out',
    255
  );
  assert.deepEqual(describeConnectFailure(timeout, target, 'linux'), {
    kind: 'failed',
    message: 'ssh root@123.45.67.89 failed:\nConnection timed out',
  });
});

test('strict checking: a key never seen is a plain failure, a changed one still blocks', () => {
  const unknownKey = new SshError(
    'x',
    'terminal',
    'No ED25519 host key is known for 123.45.67.89 and you have requested strict checking.\nHost key verification failed.',
    255
  );
  assert.equal(describeConnectFailure(unknownKey, target, 'linux').kind, 'failed');
  const changedKey = new SshError(
    'x',
    'terminal',
    'Host key for 123.45.67.89 has changed and you have requested strict checking.\nHost key verification failed.',
    255
  );
  assert.deepEqual(describeConnectFailure(changedKey, target, 'linux'), { kind: 'host-key-changed' });
});

test('node and mixdog setup errors carry the commands to run on the server', () => {
  const tooOld = new RemoteBootstrapError(
    'node-too-old',
    'Mixdog needs Node.js 22 or newer on the server; found 18.19.1.'
  );
  assert.deepEqual(describeConnectFailure(tooOld, target, 'linux'), {
    kind: 'node',
    reason: 'too-old',
    found: '18.19.1',
    required: 22,
    command: 'curl -fsSL https://fnm.vercel.app/install | bash && fnm install 22',
  });
  const missing = new RemoteBootstrapError('node-missing', 'Node.js was not found on the server (PATH=/usr/bin).');
  assert.equal(describeConnectFailure(missing, target, 'linux').found, null);
  assert.deepEqual(describeConnectFailure(new RemoteBootstrapError('npm-missing', 'x'), target, 'linux'), {
    kind: 'npm-missing',
    command: 'curl -fsSL https://fnm.vercel.app/install | bash && fnm install 22',
  });
});

test('a daemon outside proxy mode yields its pid; other bootstrap errors stay generic', () => {
  const running = new RemoteBootstrapError(
    'daemon-not-proxy',
    'A Mixdog daemon (pid 1667) is already running on the server without desktop model proxy mode; stop it (kill 1667).'
  );
  assert.deepEqual(describeConnectFailure(running, target, 'linux'), { kind: 'daemon-running', pid: 1667 });
  const other = describeConnectFailure(
    new RemoteBootstrapError('upload', 'Cannot write /x on the server.'),
    target,
    'linux'
  );
  assert.deepEqual(other, { kind: 'failed', message: 'Cannot write /x on the server.' });
});

test('the server install’s error codes each get their own view', () => {
  const view = (code, message = `${code} happened`) =>
    describeConnectFailure(new RemoteBootstrapError(code, message), target, 'linux');
  assert.deepEqual(view('unsupported-platform', 'Windows servers are not supported.'), {
    kind: 'unsupported-platform',
    message: 'Windows servers are not supported.',
  });
  assert.deepEqual(view('install-failed', 'npm exited with 1'), {
    kind: 'install-failed',
    message: 'npm exited with 1',
  });
  assert.deepEqual(view('local-payload', 'The server module lockfile is missing'), {
    kind: 'install-failed',
    message: 'The server module lockfile is missing',
  });
  assert.deepEqual(view('install-locked'), { kind: 'install-locked' });
  assert.deepEqual(view('daemon-busy-other-version', 'busy on 1.0.0'), {
    kind: 'daemon-busy',
    message: 'busy on 1.0.0',
  });
  assert.deepEqual(view('port-unavailable', 'port 7000 is taken'), {
    kind: 'port-unavailable',
    message: 'port 7000 is taken',
  });
  assert.deepEqual(view('deps-install', 'npm ERR! network'), { kind: 'deps-install', message: 'npm ERR! network' });
  for (const code of ['daemon-stop', 'daemon-replace', 'daemon-unproven', 'daemon-unmanaged', 'daemon-data-in-use'])
    assert.deepEqual(view(code, `${code} (pid 9)`), { kind: code, message: `${code} (pid 9)` });
  assert.deepEqual(view('daemon-not-proxy', 'A Mixdog daemon (pid 42) is already running.'), {
    kind: 'daemon-running',
    pid: 42,
  });
  assert.equal(view('node-missing', 'node missing').kind, 'node');
});

test('a missing OpenSSH client gets the Windows install command, other systems only the message', () => {
  const error = new SshError('The OpenSSH client (ssh) was not found on PATH.', 'terminal');
  assert.deepEqual(describeConnectFailure(error, target, 'win32'), {
    kind: 'ssh-missing',
    command: 'Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0',
  });
  assert.deepEqual(describeConnectFailure(error, target, 'linux'), { kind: 'ssh-missing', command: null });
});

test('the unexpected, protocol-version and login-shell errors have their own views', () => {
  const view = (code, message = `${code} happened`) =>
    describeConnectFailure(new RemoteBootstrapError(code, message), target, 'linux');
  assert.deepEqual(view('protocol-mismatch', 'server speaks protocol 3'), {
    kind: 'protocol-mismatch',
    message: 'server speaks protocol 3',
  });
  for (const code of ['internal', 'protocol'])
    assert.deepEqual(view(code, 'boom'), { kind: 'internal', message: 'boom' });
  for (const code of ['remote-shell', 'remote-home'])
    assert.deepEqual(view(code, 'Remote bootstrap exited with status 1.'), {
      kind: 'remote-shell',
      message: 'Remote bootstrap exited with status 1.',
    });
});

test('every failure view carries the error code: the bootstrap code, or the view’s own name for ssh errors', () => {
  const code = (error) => describeWithCode(error, target, 'linux').code;
  for (const name of [
    'install-failed',
    'install-locked',
    'daemon-busy-other-version',
    'port-unavailable',
    'protocol-mismatch',
    'internal',
    'remote-shell',
    'remote-home',
    'node-missing',
    'npm-missing',
    'upload',
  ]) {
    assert.equal(code(new RemoteBootstrapError(name, 'x')), name);
  }
  assert.equal(code(new RemoteBootstrapError('daemon-not-proxy', 'pid 5')), 'daemon-not-proxy');
  assert.equal(code(new SshError('x', 'terminal', 'Permission denied (publickey).', 255)), 'auth');
  assert.equal(code(new SshError('x', 'terminal', 'REMOTE HOST IDENTIFICATION HAS CHANGED', 255)), 'host-key-changed');
  assert.equal(code(new SshError('timed out', 'transient', 'Connection timed out', 255)), 'ssh-transient');
  assert.equal(code(new Error('odd')), 'failed');
});
