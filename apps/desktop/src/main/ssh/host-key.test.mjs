import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { entriesFor, hostFieldMatches, parseKnownHostsText } from './known-hosts.ts';
import {
  inspectHostKey,
  keyFingerprint,
  parseKeyLines,
  parseSshConfigDump,
  pinHostKey,
  privateScanDir,
  replaceHostKey,
  scanThroughSsh,
} from './host-key.ts';
import { parseSshTarget } from './ssh-command.ts';

import { makeTempDirSync } from '../../../../../scripts/lib/scoped-temp.mjs';
const keyOf = (label) => Buffer.from(`key-${label}`).toString('base64');
const fingerprintOf = (label) =>
  `SHA256:${createHash('sha256').update(`key-${label}`).digest('base64').replace(/=+$/, '')}`;

const HOME = join('/home', 'tester');
const USER_FILE = join(HOME, '.ssh', 'known_hosts');
const GLOBAL_FILE = '/etc/ssh/ssh_known_hosts';
const DUMP =
  'user root\nhostname 10.0.0.1\nport 22\nuserknownhostsfile ~/.ssh/known_hosts\nglobalknownhostsfile /etc/ssh/ssh_known_hosts\n';

/** ssh -G and ssh-keyscan stand-ins; `dumps` maps a destination to its ssh -G text. */
function tools({ dump = DUMP, dumps = {}, scan = '', scans = {}, scanFails = false }) {
  const calls = [];
  const run = async (command, args) => {
    calls.push([command, ...args]);
    if (command === 'ssh') {
      const destination = args[args.length - 1];
      return { code: 0, stdout: dumps[destination] ?? dump, stderr: '' };
    }
    if (scanFails)
      return {
        code: 0,
        stdout: '',
        stderr: '# 10.0.0.1:22 SSH-2.0-x\nconnect to host 10.0.0.1 port 22: Connection refused\n',
      };
    return { code: 0, stdout: scans[args[args.length - 1]] ?? scan, stderr: '' };
  };
  return { run, calls };
}
const files = (map) => async (file) => map[file] ?? null;
const inspect = (target, { run, files: texts = {}, ...rest }) =>
  inspectHostKey(parseSshTarget(target), { run, readText: files(texts), home: HOME, env: {}, ...rest });

test('key lines and fingerprints follow the SHA256:<unpadded base64> form', () => {
  const lines = parseKeyLines(
    `# comment\n10.0.0.1 ssh-ed25519 ${keyOf('a')}\n@revoked 10.0.0.1 ssh-rsa ${keyOf('b')}\n`
  );
  assert.deepEqual(lines, [{ hosts: '10.0.0.1', type: 'ssh-ed25519', key: keyOf('a') }]);
  assert.equal(keyFingerprint(keyOf('a')), fingerprintOf('a'));
  assert.doesNotMatch(keyFingerprint(keyOf('a')), /=/);
});

test('ssh -G resolves the real host, port, known_hosts files, key types and any proxy', () => {
  const resolved = parseSshConfigDump(
    [
      'user deploy',
      'hostname vps.example.com',
      'port 2202',
      'userknownhostsfile "~/my keys/known_hosts" ~/.ssh/known_hosts2',
      'globalknownhostsfile __PROGRAMDATA__/ssh/ssh_known_hosts',
      'hostkeyalgorithms ssh-ed25519-cert-v01@openssh.com,ssh-ed25519,rsa-sha2-512,rsa-sha2-256,ecdsa-sha2-nistp256',
      'proxyjump bastion,second',
      '',
    ].join('\n'),
    { home: HOME, env: { ProgramData: 'D:\\PD' } }
  );
  assert.equal(resolved.hostname, 'vps.example.com');
  assert.equal(resolved.port, 2202);
  assert.equal(resolved.user, 'deploy');
  assert.deepEqual(resolved.knownHostsFiles, [join(HOME, 'my keys/known_hosts'), join(HOME, '.ssh/known_hosts2')]);
  assert.deepEqual(resolved.globalKnownHostsFiles, ['D:\\PD/ssh/ssh_known_hosts']);
  assert.deepEqual(resolved.hostKeyAlgorithms, ['ssh-ed25519', 'ssh-rsa', 'ecdsa-sha2-nistp256']);
  assert.equal(resolved.proxyJump, 'bastion,second');
  assert.equal(resolved.proxied, true);
  assert.equal(parseSshConfigDump('nothing useful'), null);
  const none = parseSshConfigDump('hostname h\nport 22\nuserknownhostsfile none\nproxyjump none\nproxycommand none\n', {
    home: HOME,
  });
  assert.deepEqual([none.knownHostsFiles, none.proxied], [[], false]);
});

test('ssh -G paths with spaces and non-ASCII characters stay in one piece, quoted or not', () => {
  const dump = (list) =>
    `hostname h\nport 22\nuserknownhostsfile ${list}\nglobalknownhostsfile C:/Program Data/ssh/ssh_known_hosts /etc/ssh/ssh_known_hosts2\n`;
  const plain = parseSshConfigDump(
    dump('C:/Users/John Doe/.ssh/known_hosts ~/.ssh/known_hosts2 D:/키 폴더/known_hosts'),
    { home: HOME }
  );
  assert.deepEqual(plain.knownHostsFiles, [
    'C:/Users/John Doe/.ssh/known_hosts',
    join(HOME, '.ssh/known_hosts2'),
    'D:/키 폴더/known_hosts',
  ]);
  assert.deepEqual(plain.globalKnownHostsFiles, ['C:/Program Data/ssh/ssh_known_hosts', '/etc/ssh/ssh_known_hosts2']);
  assert.deepEqual(parseSshConfigDump(dump('"/a b/k" "/c d/k"'), { home: HOME }).knownHostsFiles, ['/a b/k', '/c d/k']);
});

test('known_hosts matching: plain, wildcard, negated and hashed host fields; markers are kept apart', () => {
  assert.ok(hostFieldMatches('10.0.0.1,gpu.example.com', 'gpu.example.com'));
  assert.ok(hostFieldMatches('*.example.com,!bad.example.com', 'gpu.example.com'));
  assert.equal(hostFieldMatches('*.example.com,!bad.example.com', 'bad.example.com'), false);
  assert.ok(hostFieldMatches('[10.0.0.1]:2202', '[10.0.0.1]:2202'));
  assert.equal(hostFieldMatches('10.0.0.1', '[10.0.0.1]:2202'), false);
  const salt = Buffer.from('salty-salt-salty-sal');
  const hash = createHmac('sha1', salt).update('vps.example.com').digest('base64');
  assert.ok(hostFieldMatches(`|1|${salt.toString('base64')}|${hash}`, 'vps.example.com'));
  assert.equal(hostFieldMatches(`|1|${salt.toString('base64')}|${hash}`, 'other.example.com'), false);
  const entries = parseKnownHostsText(
    `@revoked * ssh-rsa ${keyOf('r')}\n@cert-authority *.example.com ssh-ed25519 ${keyOf('ca')} comment\nhost ssh-ed25519 ${keyOf('p')}\n@bogus x y z\n`
  );
  assert.deepEqual(
    entries.map((entry) => entry.marker),
    ['revoked', 'cert-authority', '']
  );
  assert.equal(entriesFor(entries, 'gpu.example.com').length, 2);
});

test('an unknown server shows the key ssh would negotiate first and offers it for pinning', async () => {
  const { run, calls } = tools({ scan: `10.0.0.1 ssh-rsa ${keyOf('rsa')}\n10.0.0.1 ssh-ed25519 ${keyOf('ed')}\n` });
  const result = await inspect('root@10.0.0.1', { run });
  assert.deepEqual(result.check, { status: 'unknown', fingerprint: fingerprintOf('ed'), keyType: 'ED25519' });
  assert.equal(result.pin.line, `10.0.0.1 ssh-ed25519 ${keyOf('ed')}`);
  assert.equal(result.pin.file, USER_FILE);
  assert.deepEqual(result.summary, {
    hostName: '10.0.0.1',
    user: 'root',
    port: 22,
    proxyJump: null,
    proxyCommand: false,
  });
  assert.deepEqual(calls[0].slice(0, 2), ['ssh', '-G']);
  // HostKeyAlgorithms from the user's config decides which key is shown and pinned.
  const rsaFirst = tools({
    dump: `${DUMP}hostkeyalgorithms rsa-sha2-512,ssh-ed25519\n`,
    scan: `10.0.0.1 ssh-ed25519 ${keyOf('ed')}\n10.0.0.1 ssh-rsa ${keyOf('rsa')}\n`,
  });
  const pinned = await inspect('root@10.0.0.1', { run: rsaFirst.run });
  assert.equal(pinned.check.keyType, 'RSA');
  assert.equal(pinned.pin.line, `10.0.0.1 ssh-rsa ${keyOf('rsa')}`);
  const scanCall = rsaFirst.calls.find((call) => call[0] === 'ssh-keyscan');
  assert.equal(scanCall[scanCall.indexOf('-t') + 1], 'rsa,ed25519');
});

test('a key in the user known_hosts, or only in the system-wide one, is trusted; a port is looked up as [host]:port', async () => {
  const dump =
    'hostname 10.0.0.1\nport 2202\nuserknownhostsfile ~/.ssh/known_hosts\nglobalknownhostsfile /etc/ssh/ssh_known_hosts\n';
  const scan = `[10.0.0.1]:2202 ssh-ed25519 ${keyOf('ed')}\n`;
  const user = await inspect('root@10.0.0.1:2202', {
    ...tools({ dump, scan }),
    files: { [USER_FILE]: `[10.0.0.1]:2202 ssh-ed25519 ${keyOf('ed')}\n` },
  });
  assert.deepEqual(user.check, { status: 'trusted' });
  assert.equal(user.pin, undefined);
  const global = await inspect('root@10.0.0.1:2202', {
    ...tools({ dump, scan }),
    files: { [GLOBAL_FILE]: `[10.0.0.1]:2202 ssh-ed25519 ${keyOf('ed')}\n` },
  });
  assert.deepEqual(global.check, { status: 'trusted' });
  const wrongPort = await inspect('root@10.0.0.1:2202', {
    ...tools({ dump, scan }),
    files: { [USER_FILE]: `10.0.0.1 ssh-ed25519 ${keyOf('other')}\n` },
  });
  assert.equal(wrongPort.check.status, 'unknown', 'an entry for port 22 says nothing about port 2202');
});

test('a changed key shows both fingerprints, the exact ssh-keygen -R command and can be replaced only with the host name typed', async () => {
  const t = tools({ scan: `10.0.0.1 ssh-ed25519 ${keyOf('new')}\n` });
  const result = await inspect('root@10.0.0.1', {
    ...t,
    files: { [USER_FILE]: `10.0.0.1 ssh-ed25519 ${keyOf('old')}\n` },
  });
  assert.deepEqual(result.check, {
    status: 'changed',
    previous: fingerprintOf('old'),
    current: fingerprintOf('new'),
    keyType: 'ED25519',
    host: '10.0.0.1',
    removeCommand: 'ssh-keygen -R "10.0.0.1"',
    replaceable: false,
  });
  assert.equal(result.pin, undefined, 'a changed key is never offered for pinning');
  // A key in the user's own known_hosts is never edited by Mixdog: only the command is shown.
  assert.equal(result.replace, undefined);
  // A key Mixdog pinned itself (its own known_hosts) can be replaced from here.
  const OWN_FILE = join(HOME, 'mixdog', 'known_hosts');
  const own = await inspect('root@10.0.0.1', {
    ...t,
    mixdogKnownHosts: OWN_FILE,
    files: { [OWN_FILE]: `10.0.0.1 ssh-ed25519 ${keyOf('old')}\n` },
  });
  assert.equal(own.check.replaceable, true);
  assert.deepEqual(own.replace, {
    spec: '10.0.0.1',
    file: OWN_FILE,
    line: `10.0.0.1 ssh-ed25519 ${keyOf('new')}`,
    host: '10.0.0.1',
  });
  assert.match(own.check.removeCommand, /-f /);
  // A key from the system file cannot be edited by the user: the command names the file, no replace.
  const system = await inspect('root@10.0.0.1', {
    ...t,
    files: { [GLOBAL_FILE]: `10.0.0.1 ssh-ed25519 ${keyOf('old')}\n` },
  });
  assert.equal(system.check.removeCommand, `ssh-keygen -R "10.0.0.1" -f "${GLOBAL_FILE}"`);
  assert.equal(system.replace, undefined);
});

test('replacing a key removes the old entry through ssh-keygen -R and pins the new one', async () => {
  const dir = makeTempDirSync('known');
  const file = join(dir, 'known_hosts');
  await writeFile(file, `10.0.0.1 ssh-ed25519 ${keyOf('old')}\n`);
  const calls = [];
  const run = async (command, args) => {
    calls.push([command, ...args]);
    await writeFile(file, '');
    return { code: 0, stdout: '', stderr: '' };
  };
  await replaceHostKey({ spec: '10.0.0.1', file, line: `10.0.0.1 ssh-ed25519 ${keyOf('new')}`, host: '10.0.0.1' }, run);
  assert.deepEqual(calls, [['ssh-keygen', '-R', '10.0.0.1', '-f', file]]);
  assert.equal(await readFile(file, 'utf8'), `10.0.0.1 ssh-ed25519 ${keyOf('new')}\n`);
  await assert.rejects(
    replaceHostKey({ spec: 'x', file, line: 'x ssh-ed25519 AAAA', host: 'x' }, async () => ({
      code: 1,
      stdout: '',
      stderr: 'no such file',
    })),
    /no such file/
  );
});

test('a revoked key is refused; a certificate authority is shown, not pinned', async () => {
  const scan = `10.0.0.1 ssh-ed25519 ${keyOf('ed')}\n`;
  const revoked = await inspect('root@10.0.0.1', {
    ...tools({ scan }),
    files: { [USER_FILE]: `@revoked 10.0.0.1 ssh-ed25519 ${keyOf('ed')}\n` },
  });
  assert.deepEqual(revoked.check, { status: 'revoked', fingerprint: fingerprintOf('ed'), host: '10.0.0.1' });
  assert.equal(revoked.pin, undefined);
  // Revoked everywhere (`*`), even when the same key is also listed as known.
  const everywhere = await inspect('root@10.0.0.1', {
    ...tools({ scan }),
    files: {
      [GLOBAL_FILE]: `@revoked * ssh-ed25519 ${keyOf('ed')}\n`,
      [USER_FILE]: `10.0.0.1 ssh-ed25519 ${keyOf('ed')}\n`,
    },
  });
  assert.equal(everywhere.check.status, 'revoked');
  const authority = await inspect('root@10.0.0.1', {
    ...tools({
      dump: DUMP.replace('10.0.0.1', 'gpu.example.com'),
      scan: `gpu.example.com ssh-ed25519 ${keyOf('ed')}\n`,
    }),
    files: { [USER_FILE]: `@cert-authority *.example.com ssh-ed25519 ${keyOf('ca')}\n` },
  });
  assert.deepEqual(authority.check, { status: 'trusted', authority: fingerprintOf('ca') });
  assert.equal(authority.pin, undefined);
});

test('an unreadable server is unreachable unless known_hosts already has it', async () => {
  const blocked = await inspect('root@10.0.0.1', tools({ scanFails: true }));
  assert.equal(blocked.check.status, 'unreachable');
  assert.match(blocked.check.message, /Connection refused/);
  const known = await inspect('root@10.0.0.1', {
    ...tools({ scanFails: true }),
    files: { [USER_FILE]: `10.0.0.1 ssh-ed25519 ${keyOf('ed')}\n` },
  });
  assert.deepEqual(known.check, { status: 'trusted' });
});

test('a missing OpenSSH client is reported with the Windows install command', async () => {
  const run = async () => {
    throw new Error('The OpenSSH client (ssh) was not found on PATH.');
  };
  const windows = await inspect('root@10.0.0.1', { run, platform: 'win32' });
  assert.equal(windows.check.status, 'unreachable');
  assert.deepEqual(windows.check.sshMissing, {
    command: 'Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0',
  });
  assert.deepEqual((await inspect('root@10.0.0.1', { run, platform: 'linux' })).check.sshMissing, { command: null });
});

test('behind ProxyJump the servers are read hop by hop: a hop is read through the ones before it only once they are trusted', async () => {
  const dumps = {
    'jump-target':
      'hostname 10.1.0.5\nport 22\nuserknownhostsfile ~/.ssh/known_hosts\nproxyjump ops@bastion.example.com:2200\n',
    'ops@bastion.example.com': 'hostname bastion.example.com\nport 2200\nuserknownhostsfile ~/.ssh/known_hosts\n',
  };
  const bastionLine = `[bastion.example.com]:2200 ssh-ed25519 ${keyOf('bastion')}`;
  const scans = { 'bastion.example.com': `${bastionLine}\n` };
  const viaProxyEntries = [{ marker: '', hosts: '10.1.0.5', type: 'ssh-ed25519', key: keyOf('target') }];

  // Nothing trusted yet: the first hop is read directly (no login, no proxy), the target waits.
  const seen = [];
  const both = await inspect('jump-target', {
    ...tools({ dumps, scans }),
    scanViaProxy: async (...args) => {
      seen.push(args);
      return { entries: viaProxyEntries, error: '' };
    },
  });
  assert.deepEqual(seen, [], 'a server behind an untrusted hop is not dialed');
  assert.equal(both.check.status, 'unknown');
  assert.deepEqual(both.check.hops, [
    {
      name: 'ops@bastion.example.com:2200',
      role: 'jump',
      status: 'unknown',
      fingerprint: fingerprintOf('bastion'),
      keyType: 'ED25519',
    },
    { name: 'jump-target', role: 'target', status: 'pending' },
  ]);
  assert.equal(both.check.fingerprint, fingerprintOf('bastion'));
  assert.equal(both.pin.line, bastionLine, 'only the key that was read is offered');
  assert.equal(both.summary.proxyJump, 'ops@bastion.example.com:2200');

  // Hop trusted: the target is read through it, with the hop's key seeded so it is checked strictly on the way.
  const hopKnown = await inspect('jump-target', {
    ...tools({ dumps, scans }),
    files: { [USER_FILE]: `${bastionLine}\n` },
    scanViaProxy: async (target, scope) => {
      seen.push([target.display, scope]);
      return { entries: viaProxyEntries, error: '' };
    },
  });
  assert.deepEqual(seen.at(-1), [
    'jump-target',
    { open: '10.1.0.5', via: ['ops@bastion.example.com:2200'], trusted: bastionLine },
  ]);
  assert.deepEqual(
    hopKnown.check.hops.map((hop) => hop.status),
    ['trusted', 'unknown']
  );
  assert.equal(hopKnown.pin.line, `10.1.0.5 ssh-ed25519 ${keyOf('target')}`);

  // A changed hop blocks the whole connection and the target is never dialed.
  const before = seen.length;
  const hopChanged = await inspect('jump-target', {
    ...tools({ dumps, scans }),
    files: { [USER_FILE]: `[bastion.example.com]:2200 ssh-ed25519 ${keyOf('old-bastion')}\n` },
    scanViaProxy: async () => {
      seen.push('dialed');
      return { entries: viaProxyEntries, error: '' };
    },
  });
  assert.equal(seen.length, before);
  assert.equal(hopChanged.check.status, 'changed');
  assert.equal(hopChanged.check.host, 'bastion.example.com');
  assert.equal(hopChanged.check.removeCommand, 'ssh-keygen -R "[bastion.example.com]:2200"');

  // The target could not be read through a trusted hop: nothing is offered for pinning.
  const blocked = await inspect('jump-target', {
    ...tools({ dumps, scans }),
    files: { [USER_FILE]: `${bastionLine}\n` },
    scanViaProxy: async () => ({ entries: [], error: 'ssh: connect to host 10.1.0.5 port 22: Connection timed out' }),
  });
  assert.equal(blocked.check.status, 'unreachable');
  assert.match(blocked.check.message, /Connection timed out/);
  assert.equal(blocked.pin, undefined);
});

test('the proxy read switches the login off for the server being read only, and checks the hops before it strictly', async () => {
  const dir = makeTempDirSync('scan');
  const configs = [];
  const run = async (command, args) => {
    if (command === 'ssh') {
      const file = args[args.indexOf('-F') + 1];
      configs.push({
        args,
        text: await readFile(file, 'utf8'),
        known: await readFile(join(dirname(file), 'known_hosts'), 'utf8'),
      });
    }
    return { code: 0, stdout: '', stderr: '' };
  };
  try {
    const scan = scanThroughSsh(run, HOME, { platform: 'linux', tmp: dir });
    await scan(parseSshTarget('jump-target'), {
      open: '10.1.0.5',
      via: ['ops@bastion:2200'],
      trusted: 'bastion ssh-ed25519 AAAA',
    });
    const [hop] = configs;
    assert.match(
      hop.text,
      /^Match host "10\.1\.0\.5"\n {2}PreferredAuthentications none\n {2}PubkeyAuthentication no\n {2}PasswordAuthentication no\n {2}KbdInteractiveAuthentication no\n {2}StrictHostKeyChecking no\n/
    );
    assert.match(
      hop.text,
      /Host \*\n {2}UserKnownHostsFile .*\n {2}GlobalKnownHostsFile none\n {2}StrictHostKeyChecking yes/
    );
    assert.equal(hop.known, 'bastion ssh-ed25519 AAAA\n', 'the trusted hops are seeded');
    assert.ok(hop.args.join(' ').includes('-o ProxyJump=ops@bastion:2200'));
    await scan(parseSshTarget('behind-command'), { open: '*' });
    assert.match(
      configs[1].text,
      /^Host \*\n {2}PreferredAuthentications none\n {2}PubkeyAuthentication no\n {2}PasswordAuthentication no\n {2}KbdInteractiveAuthentication no/
    );
    assert.equal(
      configs[1].args.some((arg) => arg.startsWith('ProxyJump=')),
      false,
      'the configured route is used'
    );
    await assert.rejects(scan(parseSshTarget('x'), { open: 'a"b' }), /cannot be read through a proxy/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('ProxyCommand reads the target through the same ssh-based scan', async () => {
  const scopes = [];
  const dump = `${DUMP}proxycommand nc -X 5 -x proxy:1080 10.0.0.1 22\n`;
  const result = await inspect('root@10.0.0.1', {
    ...tools({ dump }),
    scanViaProxy: async (_target, scope) => {
      scopes.push(scope);
      return { entries: [{ marker: '', hosts: '10.0.0.1', type: 'ssh-ed25519', key: keyOf('ed') }], error: '' };
    },
  });
  assert.deepEqual(scopes, [{ open: '*' }], 'no login is made to a target behind a proxy command');
  assert.equal(result.check.status, 'unknown');
  assert.equal(result.check.hops, undefined, 'a single server has no hop list');
  assert.equal(result.summary.proxyCommand, true);
});

test('known_hosts in a profile folder with spaces and non-ASCII characters is read and written', async () => {
  const home = makeTempDirSync('mixdog 홈 폴더 ');
  const file = join(home, '.ssh', 'known_hosts');
  const t = tools({ scan: `10.0.0.1 ssh-ed25519 ${keyOf('ed')}\n` });
  const first = await inspectHostKey(parseSshTarget('root@10.0.0.1'), { run: t.run, home, env: {} });
  assert.equal(first.check.status, 'unknown');
  assert.equal(first.pin.file, file);
  await pinHostKey(first.pin);
  const second = await inspectHostKey(parseSshTarget('root@10.0.0.1'), { run: t.run, home, env: {} });
  assert.deepEqual(second.check, { status: 'trusted' });
  assert.equal(await readFile(file, 'utf8'), `10.0.0.1 ssh-ed25519 ${keyOf('ed')}\n`);
});

test('pinning appends the confirmed key on its own line, creating the folder', async () => {
  const dir = makeTempDirSync('known');
  const file = join(dir, '.ssh', 'known_hosts');
  await pinHostKey({ line: `10.0.0.1 ssh-ed25519 ${keyOf('a')}`, file });
  await writeFile(file, `10.0.0.9 ssh-ed25519 ${keyOf('b')}`, { flag: 'a' });
  await pinHostKey({ line: `10.0.0.2 ssh-ed25519 ${keyOf('c')}`, file });
  assert.deepEqual((await readFile(file, 'utf8')).split('\n'), [
    `10.0.0.1 ssh-ed25519 ${keyOf('a')}`,
    `10.0.0.9 ssh-ed25519 ${keyOf('b')}`,
    `10.0.0.2 ssh-ed25519 ${keyOf('c')}`,
    '',
  ]);
  await mkdir(join(dir, 'x'), { recursive: true });
});
test('the jump-host key scan runs from a folder without spaces: a Windows temp folder with spaces falls back to a locked-down ProgramData folder', async () => {
  const programData = makeTempDirSync('pd');
  const calls = [];
  const run = async (command, args) => {
    calls.push([command, ...args]);
    return { code: 0, stdout: '', stderr: '' };
  };
  const dir = await privateScanDir(run, {
    platform: 'win32',
    tmp: 'C:\\Users\\John Doe\\AppData\\Local\\Temp',
    env: { ProgramData: programData },
    user: 'John Doe',
  });
  assert.ok(dir.startsWith(join(programData, 'mixdog-ssh-scan-John_Doe')));
  assert.doesNotMatch(dir.slice(programData.length), /\s/);
  // The shared parent is locked first, then the random folder, before anything is written into it.
  assert.deepEqual(calls, [
    ['icacls', dirname(dir), '/inheritance:r', '/grant:r', 'John Doe:(OI)(CI)F'],
    ['icacls', dir, '/inheritance:r', '/grant:r', 'John Doe:(OI)(CI)F'],
  ]);
  await assert.rejects(
    privateScanDir(async () => ({ code: 5, stdout: '', stderr: 'Access is denied.' }), {
      platform: 'win32',
      tmp: 'C:\\a b',
      env: { ProgramData: programData },
    }),
    /Access is denied/
  );
  // A temp folder without spaces, or any other system, is used as it is.
  const plain = await privateScanDir(run, { platform: 'win32', tmp: programData, env: {} });
  assert.ok(plain.startsWith(programData));
  assert.equal(calls.length, 2);
  assert.ok((await privateScanDir(run, { platform: 'linux', tmp: programData })).startsWith(programData));
});
