import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { parseSshConfigDump, pinHostKey } from './host-key.ts';
import {
  configureMixdogSsh,
  mixdogKnownHostsFile,
  mixdogSshConfigFile,
  mixdogSshConfigText,
  registerUserKnownHosts,
  resetMixdogSsh,
} from './mixdog-ssh-config.ts';
import { SSH_COMMON_OPTIONS, sshTunnelArgs, parseSshTarget } from './ssh-command.ts';
import { makeTempDirSync } from '../../../../../scripts/lib/scoped-temp.mjs';

const okRun = async () => ({ code: 0, stdout: '', stderr: '' });

test('no ssh Mixdog starts forwards the agent or X11 on its own', () => {
  const flat = SSH_COMMON_OPTIONS.join(' ');
  for (const option of ['ForwardAgent=no', 'ForwardX11=no', 'ForwardX11Trusted=no', 'StrictHostKeyChecking=yes'])
    assert.ok(flat.includes(option), option);
  // ClearAllForwardings would drop the tunnel's own -L as well (ssh -G shows no localforward), so it is not on the tunnel.
  const tunnel = sshTunnelArgs(parseSshTarget('root@h'), 1, 2);
  assert.equal(
    tunnel.some((arg) => /ClearAllForwardings/.test(arg)),
    false
  );
  assert.ok(tunnel.includes('-L'));
});

test('forwards the ssh config defines are collected from ssh -G, all of them', () => {
  const host = parseSshConfigDump(
    'hostname h\nport 22\nlocalforward [127.0.0.1]:8080 [127.0.0.1]:80\nremoteforward [0.0.0.0]:9 [127.0.0.1]:9\ndynamicforward [127.0.0.1]:1080\n',
    { home: '/h', env: {} }
  );
  assert.deepEqual(host.forwards, [
    'local [127.0.0.1]:8080 [127.0.0.1]:80',
    'remote [0.0.0.0]:9 [127.0.0.1]:9',
    'dynamic [127.0.0.1]:1080',
  ]);
  assert.deepEqual(parseSshConfigDump('hostname h\nport 22\n', { home: '/h', env: {} }).forwards, []);
});

test('Mixdog keeps its own known_hosts: new pins land there and the config lists it before the user’s files', async () => {
  resetMixdogSsh();
  assert.equal(mixdogKnownHostsFile(), null);
  const userData = makeTempDirSync('ssh-cfg');
  const home = join(userData, 'home');
  await configureMixdogSsh({ userDataPath: userData, run: okRun, home, place: { platform: 'linux' } });
  const known = mixdogKnownHostsFile();
  const config = mixdogSshConfigFile();
  assert.equal(known, join(userData, 'ssh', 'known_hosts'));
  assert.equal(config, join(userData, 'ssh', 'config'));
  if (process.platform !== 'win32') assert.equal((await stat(join(userData, 'ssh'))).mode & 0o777, 0o700);
  let text = await readFile(config, 'utf8');
  assert.match(
    text,
    /^Host \*\n {2}UserKnownHostsFile ".*known_hosts" ~\/\.ssh\/known_hosts ~\/\.ssh\/known_hosts2\n/m
  );
  assert.ok(
    text.indexOf('mixdog') < 0 || text.indexOf(userData.replace(/\\/g, '/')) < text.indexOf('~/.ssh/known_hosts'),
    'Mixdog’s file comes first'
  );
  assert.match(text, /\nInclude ".*\.ssh\/config"\n/);
  // A custom file the user's config names for a server is kept in the list, once.
  const custom = join(home, 'work', 'hosts');
  await registerUserKnownHosts([custom, custom, '~/.ssh/known_hosts', 'none']);
  text = await readFile(config, 'utf8');
  assert.equal(text.split(custom.replace(/\\/g, '/')).length - 1, 1);
  assert.equal(text.includes('none'), false);
  // A pin goes to Mixdog's file; the user's own file is never touched.
  const userFile = join(home, '.ssh', 'known_hosts');
  await pinHostKey({ line: 'h ssh-ed25519 AAAA', file: known });
  assert.equal(await readFile(known, 'utf8'), 'h ssh-ed25519 AAAA\n');
  await assert.rejects(stat(userFile));
  resetMixdogSsh();
});

test('the config words quote paths with spaces and non-ASCII characters', () => {
  const text = mixdogSshConfigText('C:\\Users\\김 철수\\ssh\\known_hosts', ['D:\\내 키\\hosts'], 'C:\\Users\\김 철수');
  assert.match(
    text,
    /UserKnownHostsFile "C:\/Users\/김 철수\/ssh\/known_hosts" ~\/\.ssh\/known_hosts ~\/\.ssh\/known_hosts2 "D:\/내 키\/hosts"/
  );
  assert.match(text, /Include "C:\/Users\/김 철수\/\.ssh\/config"/);
});
