import assert from 'node:assert/strict';
import { test } from 'node:test';

import { join } from 'node:path';

import { expandSshConfigIncludes, parseSshConfigHosts, readSshConfigHosts } from './ssh-config.ts';

test('Host aliases come with the user@host[:port] they resolve to; wildcard patterns are skipped', () => {
  const hosts = parseSshConfigHosts(`
# my servers
Host gpu-box
  HostName 10.0.0.21
  User jae

Host vps-main vps-backup
    HostName=vps.example.com
    User root
    Port 2202

Host *
  ServerAliveInterval 30

Host !internal web-?? plain
  Port 22

Match host foo
  User ignored
`);
  assert.deepEqual(hosts, [
    { alias: 'gpu-box', detail: 'jae@10.0.0.21' },
    { alias: 'vps-main', detail: 'root@vps.example.com:2202' },
    { alias: 'vps-backup', detail: 'root@vps.example.com:2202' },
    { alias: 'plain', detail: 'plain' },
  ]);
});

test('an alias already listed is not repeated', () => {
  assert.deepEqual(
    parseSshConfigHosts('Host a\n  HostName x\nHost a\n  HostName y\n').map((host) => host.detail),
    ['x']
  );
});

/** An in-memory ~/.ssh: path → text; directories are whatever the paths imply. */
const fakeFiles = (tree) => ({
  readText: (path) => tree[path] ?? null,
  listNames: (directory) =>
    Object.keys(tree)
      .filter((path) => path.startsWith(`${directory}\\`) || path.startsWith(`${directory}/`))
      .map((path) => path.slice(directory.length + 1)),
});
const HOME = join('/home', '김 철수');
const SSH = join(HOME, '.ssh');

test('Include pulls in relative, ~ and wildcard files so their aliases reach the picker', async () => {
  const tree = {
    [join(SSH, 'config')]:
      'Include work/*.conf\nInclude ~/extra/hosts "~/extra/spaced name"\nHost top\n  HostName top.example.com\n',
    [join(SSH, 'work', 'a.conf')]: 'Host work-a\n  HostName a.example.com\n  User ann\n',
    [join(SSH, 'work', 'b.conf')]: 'Host work-b\n  HostName b.example.com\n',
    [join(SSH, 'work', 'readme.txt')]: 'Host ignored\n',
    [join(HOME, 'extra', 'hosts')]: 'Host extra\n',
    [join(HOME, 'extra', 'spaced name')]: 'Host spaced\n',
  };
  const hosts = await readSshConfigHosts(join(SSH, 'config'), { home: HOME, files: fakeFiles(tree) });
  assert.deepEqual(
    hosts.map((host) => host.alias),
    ['work-a', 'work-b', 'extra', 'spaced', 'top']
  );
  assert.equal(hosts[0].detail, 'ann@a.example.com');
});

test('Include loops and chains deeper than the limit are cut, a missing file is skipped', () => {
  const loop = {
    [join(SSH, 'a')]: 'Host a\nInclude b\n',
    [join(SSH, 'b')]: 'Host b\nInclude a\n',
  };
  const text = expandSshConfigIncludes('Include a\nInclude nothing-here\n', { home: HOME, files: fakeFiles(loop) });
  assert.deepEqual(
    parseSshConfigHosts(text).map((host) => host.alias),
    ['a', 'b']
  );
  const deep = {};
  for (let i = 0; i < 20; i += 1) deep[join(SSH, `f${i}`)] = `Host h${i}\nInclude f${i + 1}\n`;
  const aliases = parseSshConfigHosts(
    expandSshConfigIncludes('Include f0\n', { home: HOME, files: fakeFiles(deep) })
  ).map((host) => host.alias);
  assert.ok(aliases.length >= 5 && aliases.length <= 9);
});
