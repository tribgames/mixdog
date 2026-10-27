import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { configureMixdogSsh, resetMixdogSsh } from './mixdog-ssh-config.ts';
import { parseSshTarget } from './ssh-command.ts';
import { prepareSshSpawn } from './ssh-auth.ts';
import {
  forwardsOf,
  parseDump,
  prepareTargetSshConfig,
  resetTargetSshConfigs,
  resolvedBlockText,
  targetSshConfigFor,
} from './ssh-resolved-config.ts';
import { makeTempDirSync } from '../../../../../scripts/lib/scoped-temp.mjs';

const DUMP = (extra = '') =>
  `user ops\nhostname 10.0.0.9\nport 22\nidentityfile ~/.ssh/id_ed25519\nforwardagent yes\nforwardx11 yes\nlocalforward [127.0.0.1]:8080 [127.0.0.1]:80\nremoteforward [0.0.0.0]:9 [127.0.0.1]:9\ndynamicforward [127.0.0.1]:1080\npermitlocalcommand yes\nlocalcommand echo hi\nuserknownhostsfile ~/.ssh/known_hosts\nserveraliveinterval 30\n${extra}`;

/** An ssh stand-in: `ssh -G` of the user's config, and `ssh -G -F <generated>` that reads the generated file back. */
function fakeSsh({ dumps, faithful = true }) {
  const calls = [];
  const run = async (command, args) => {
    calls.push([command, ...args]);
    const destination = args[args.length - 1];
    const generated = args[0] === '-G' && args[1] === '-F';
    if (!generated) return { code: 0, stdout: dumps[destination] ?? '', stderr: '' };
    const text = await readFile(args[2], 'utf8');
    const block = new RegExp(
      `Host "${destination.slice(destination.lastIndexOf('@') + 1)}"\\n([\\s\\S]*?)(?=\\nHost |\\n$|$)`
    ).exec(text);
    const lines = (block?.[1] ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    return { code: 0, stdout: faithful ? lines.join('\n') : 'user nobody\n', stderr: '' };
  };
  return { run, calls };
}

async function configured() {
  resetMixdogSsh();
  resetTargetSshConfigs();
  const userData = makeTempDirSync('resolved');
  await configureMixdogSsh({
    userDataPath: userData,
    run: async () => ({ code: 0, stdout: '', stderr: '' }),
    home: join(userData, 'home'),
    place: { platform: 'linux' },
  });
  return userData;
}

test('the generated block carries every resolved option except forwarding ones, with Mixdog’s known_hosts first', () => {
  const lines = parseDump(DUMP());
  const text = resolvedBlockText(
    {
      pattern: 'gate',
      lines,
      host: { knownHostsFiles: ['/h/.ssh/known_hosts'], globalKnownHostsFiles: ['/etc/ssh/ssh_known_hosts'] },
    },
    '/data/known_hosts'
  );
  assert.match(
    text,
    /^Host "gate"\n {2}UserKnownHostsFile "\/data\/known_hosts" "\/h\/\.ssh\/known_hosts"\n {2}GlobalKnownHostsFile "\/etc\/ssh\/ssh_known_hosts"\n/
  );
  for (const kept of ['user ops', 'hostname 10.0.0.9', 'identityfile ~/.ssh/id_ed25519', 'serveraliveinterval 30'])
    assert.ok(text.includes(`  ${kept}\n`) || text.endsWith(`  ${kept}`), kept);
  for (const gone of ['forward', 'localcommand', 'permitlocalcommand'])
    assert.equal(new RegExp(`^ {2}\\w*${gone}`, 'm').test(text), false, gone);
  assert.deepEqual(forwardsOf(lines), [
    'local [127.0.0.1]:8080 [127.0.0.1]:80',
    'remote [0.0.0.0]:9 [127.0.0.1]:9',
    'dynamic [127.0.0.1]:1080',
  ]);
  // A key file with spaces, printed bare by some builds, is quoted.
  assert.match(
    resolvedBlockText(
      {
        pattern: 'g',
        lines: parseDump('identityfile C:/Users/John Doe/.ssh/id\n'),
        host: { knownHostsFiles: [], globalKnownHostsFiles: [] },
      },
      '/k'
    ),
    /identityfile "C:\/Users\/John Doe\/\.ssh\/id"/
  );
});

test('a faithful per-target config replaces the user’s: no forwards apply and every ssh of the target uses it', async () => {
  const userData = await configured();
  const t = fakeSsh({ dumps: { 'ops@gate': DUMP() } });
  const result = await prepareTargetSshConfig(t.run, parseSshTarget('ops@gate'));
  assert.deepEqual(result, { resolved: true, forwards: [] });
  const file = targetSshConfigFor(['-o', 'BatchMode=yes', '-T', '--', 'ops@gate', 'true']);
  assert.ok(file?.startsWith(userData) || file?.includes('t-'), 'the target has its own file');
  const text = await readFile(file, 'utf8');
  assert.equal(/Include/i.test(text), false, 'the user’s config is not included');
  assert.equal(/localforward|remoteforward|dynamicforward/i.test(text), false);
  // exec, probe and tunnel arguments all pick it; other targets and ports do not.
  assert.deepEqual(
    prepareSshSpawn('ssh', ['-N', '-L', '1:2:3', '--', 'ops@gate'], undefined, 'linux', {}, '/generic').args.slice(
      0,
      2
    ),
    ['-F', file]
  );
  assert.equal(targetSshConfigFor(['-p', '2200', '--', 'ops@gate', 'true']), null);
  assert.equal(
    prepareSshSpawn('ssh', ['--', 'ops@other', 'true'], undefined, 'linux', {}, '/generic').args[1],
    '/generic'
  );
});

test('each ProxyJump hop gets its own resolved block so the hop’s ssh resolves correctly from the same file', async () => {
  await configured();
  const t = fakeSsh({
    dumps: {
      'ops@inner': DUMP('proxyjump jump@bastion:2200\n'),
      'jump@bastion':
        'user jump\nhostname bastion.example.com\nport 2200\nlocalforward [127.0.0.1]:1 [127.0.0.1]:2\nserveraliveinterval 15\n',
    },
  });
  const result = await prepareTargetSshConfig(t.run, parseSshTarget('ops@inner'));
  assert.equal(result.resolved, true);
  const text = await readFile(targetSshConfigFor(['--', 'ops@inner', 'true']), 'utf8');
  assert.match(text, /Host "inner"[\s\S]*proxyjump jump@bastion:2200/);
  assert.match(text, /Host "bastion"\n[\s\S]*hostname bastion\.example\.com[\s\S]*port 2200/);
  assert.equal(/localforward/i.test(text), false, 'a hop’s forwards are left out too');
  assert.ok(
    t.calls.some((call) => call.includes('jump@bastion') && call[1] === '-G'),
    'the hop is resolved on its own'
  );
});

test('when the generated config cannot say what ssh resolved, the generic config stays and the forwards are listed', async () => {
  await configured();
  const t = fakeSsh({ dumps: { 'ops@gate': DUMP() }, faithful: false });
  const result = await prepareTargetSshConfig(t.run, parseSshTarget('ops@gate'));
  assert.equal(result.resolved, false);
  assert.deepEqual(result.forwards, [
    'local [127.0.0.1]:8080 [127.0.0.1]:80',
    'remote [0.0.0.0]:9 [127.0.0.1]:9',
    'dynamic [127.0.0.1]:1080',
  ]);
  assert.equal(targetSshConfigFor(['--', 'ops@gate', 'true']), null, 'no per-target file is used');
  const failing = await prepareTargetSshConfig(
    async () => ({ code: 255, stdout: '', stderr: 'boom' }),
    parseSshTarget('ops@gate')
  );
  assert.deepEqual(failing, { resolved: false, forwards: [] });
});

test('a path that ssh -G printed lossily (`?` for a character of the console code page) is not carried: the generic config stays', async () => {
  await configured();
  const t = fakeSsh({
    dumps: {
      'ops@gate': DUMP('identityfile C:/Users/김 철수/.ssh/id\n').replace('~/.ssh/id_ed25519', 'C:/Users/? ?/.ssh/id'),
    },
  });
  const result = await prepareTargetSshConfig(t.run, parseSshTarget('ops@gate'));
  assert.equal(result.resolved, false);
  assert.equal(targetSshConfigFor(['--', 'ops@gate', 'true']), null);
});
