import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';

import { makeTempDirSync } from '../../../../../scripts/lib/scoped-temp.mjs';
import { classifyPrompt, ensureAskpassHelper, prepareSshSpawn, startAskpassSession } from './ssh-auth.ts';
import { resolvePlainDir } from './ssh-private-dir.ts';

const okRun = async () => ({ code: 0, stdout: '', stderr: '' });

/** Runs the real helper the way ssh does: SSH_ASKPASS script, prompt as the argument. */
function runHelper(session, prompt, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [session.env.SSH_ASKPASS.replace(/askpass\.(cmd|sh)$/, 'askpass.cjs'), prompt],
      {
        env: { ...process.env, ...session.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    let stdout = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.once('close', (code) => resolve({ code, stdout }));
  });
}

async function session(ask, extra = {}) {
  const helperDir = makeTempDirSync('askpass 헬퍼');
  const started = await startAskpassSession({ ask, helperDir, run: okRun, ...extra });
  return started;
}

test('classifyPrompt tells a passphrase, a password and a one-time code apart', () => {
  assert.equal(classifyPrompt("Enter passphrase for key '/home/u/.ssh/id_ed25519': "), 'passphrase');
  assert.equal(classifyPrompt("root@10.0.0.1's password: "), 'password');
  assert.equal(classifyPrompt('Password: '), 'password');
  assert.equal(classifyPrompt('Verification code: '), 'otp');
  assert.equal(classifyPrompt('Duo passcode or option (1-3): '), 'otp');
  assert.equal(classifyPrompt('One-time password (OATH) for root: '), 'otp');
  // Text the server supplies that is not recognizably a code is neither taken for one nor for a password.
  assert.equal(classifyPrompt('Enter your favourite colour: '), 'other');
  assert.equal(classifyPrompt('Approve the login on your phone, then press Enter: '), 'other');
});

test('askpass round trip: the helper presents the token, main asks the user, the answer reaches ssh on stdout', async () => {
  const asked = [];
  const s = await session(async (request) => {
    asked.push(request);
    return 'pa ss\u00e9w\u00f6rd';
  });
  try {
    const prompt = "Enter passphrase for key 'C:\\Users\\김 철수\\.ssh\\id_work': ";
    const result = await runHelper(s, prompt);
    assert.deepEqual(result, { code: 0, stdout: 'pa ss\u00e9w\u00f6rd\n' });
    assert.deepEqual(asked, [{ kind: 'passphrase', prompt, retry: false }]);
    assert.equal(s.env.SSH_ASKPASS.endsWith(process.platform === 'win32' ? 'askpass.cmd' : 'askpass.sh'), true);
    assert.equal(s.cancelled, false);
  } finally {
    await s.close();
  }
});

test('the helper is refused without the attempt’s token, and after the session closed', async () => {
  const asked = [];
  const s = await session(async (request) => {
    asked.push(request);
    return 'secret';
  });
  const wrong = await runHelper(s, 'password: ', { MIXDOG_ASKPASS_TOKEN: 'not-the-token' });
  assert.deepEqual(wrong, { code: 1, stdout: '' });
  assert.deepEqual(asked, [], 'a process that does not know the token never reaches the user');
  assert.deepEqual(await runHelper(s, 'password: ', { MIXDOG_ASKPASS_ENDPOINT: '' }), { code: 2, stdout: '' });
  await s.close();
  assert.equal(s.closed, true);
  assert.deepEqual(await runHelper(s, 'password: '), { code: 1, stdout: '' });
});

test('cancelling or timing out a question makes the helper fail and marks the session cancelled', async () => {
  const cancelled = await session(async () => null);
  assert.deepEqual(await runHelper(cancelled, 'password: '), { code: 1, stdout: '' });
  assert.equal(cancelled.cancelled, true);
  await cancelled.close();

  let signal;
  const slow = await session(
    (_request, abortSignal) => {
      signal = abortSignal;
      return new Promise(() => undefined);
    },
    { timeoutMs: 80 }
  );
  assert.deepEqual(await runHelper(slow, 'Verification code: '), { code: 1, stdout: '' });
  assert.equal(signal.aborted, true, 'the dialog is told to close');
  assert.equal(slow.cancelled, true);
  await slow.close();
});

test('passwords and passphrases are asked once per attempt; a refused answer is asked again; one-time codes are never reused', async () => {
  let clock = 0;
  const answers = [];
  const s = await session(
    async (request) => {
      answers.push(request);
      return `answer-${answers.length}`;
    },
    { now: () => clock, retryWindowMs: 1000 }
  );
  try {
    assert.equal((await runHelper(s, "root@h's password: ")).stdout, 'answer-1\n');
    clock = 5000; // a later handshake of the same attempt: reused
    assert.equal((await runHelper(s, "root@h's password: ")).stdout, 'answer-1\n');
    assert.equal(answers.length, 1);
    clock = 5400; // asked again right after it was served: the server refused it
    assert.equal((await runHelper(s, "root@h's password: ")).stdout, 'answer-2\n');
    assert.deepEqual(
      answers.map((request) => request.retry),
      [false, true]
    );
    clock = 20_000;
    await runHelper(s, 'Verification code: ');
    await runHelper(s, 'Verification code: ');
    assert.equal(answers.filter((request) => request.kind === 'otp').length, 2);
  } finally {
    await s.close();
  }
});

test('concurrent questions are put to the user one after the other', async () => {
  let running = 0;
  let peak = 0;
  const s = await session(async () => {
    peak = Math.max(peak, ++running);
    await new Promise((resolve) => setTimeout(resolve, 40));
    running -= 1;
    return 'x';
  });
  try {
    const results = await Promise.all([
      runHelper(s, 'password A: '),
      runHelper(s, 'password B: '),
      runHelper(s, 'Verification code: '),
    ]);
    assert.deepEqual(
      results.map((result) => result.code),
      [0, 0, 0]
    );
    assert.equal(peak, 1);
  } finally {
    await s.close();
  }
});

test('the helper wrapper files are written once, runnable, and refreshed when they differ', async () => {
  const dir = makeTempDirSync('askpass-files');
  const script = await ensureAskpassHelper(dir);
  assert.match(await readFile(join(dir, 'askpass.cjs'), 'utf8'), /MIXDOG_ASKPASS_ENDPOINT/);
  assert.equal(await ensureAskpassHelper(dir), script);
  const wrapper = await readFile(script, 'utf8');
  if (process.platform === 'win32') assert.match(wrapper, /%MIXDOG_ASKPASS_NODE%.*%~dp0askpass\.cjs.*%\*/);
  else assert.match(wrapper, /^#!\/bin\/sh\nexec "\$MIXDOG_ASKPASS_NODE"/);
});

test('the helper base folder is a plain path: the 8.3 short path of the user-data folder first, then a per-user shared root', async () => {
  const env = { ProgramData: 'C:\\ProgramData', PUBLIC: 'C:\\Users\\Public' };
  const noShort = async () => ({ code: 0, stdout: 'C:\\Users\\김철수\\AppData\\Roaming\\Mixdog\r\n', stderr: '' });
  const jae = 'C:\\Users\\jae\\AppData\\Roaming\\Mixdog';
  assert.equal(
    await resolvePlainDir(okRun, jae, 'askpass', { platform: 'win32', env, user: 'jae' }),
    `${jae}\\askpass`
  );
  const korean = 'C:\\Users\\김철수\\AppData\\Local\\Temp\\mixdog-plain-test';
  const short = async (command, args) => {
    assert.equal(command, 'powershell.exe');
    assert.match(args.at(-1), /GetFolder\('C:\\Users\\김철수/);
    return { code: 0, stdout: 'C:\\Users\\KIMCHE~1\\AppData\\Roaming\\Mixdog\r\n', stderr: '' };
  };
  assert.equal(
    await resolvePlainDir(short, korean, 'askpass', { platform: 'win32', env, user: 'jae' }),
    'C:\\Users\\KIMCHE~1\\AppData\\Roaming\\Mixdog\\askpass'
  );
  // No 8.3 names on the volume: a folder of its own under ProgramData, then Public.
  assert.equal(
    await resolvePlainDir(noShort, korean, 'askpass', { platform: 'win32', env, user: 'Kim Cheol' }),
    'C:\\ProgramData\\mixdog-askpass-Kim_Cheol'
  );
  assert.equal(
    await resolvePlainDir(noShort, korean, 'askpass', {
      platform: 'win32',
      env: { PUBLIC: 'C:\\Users\\Public' },
      user: 'k',
    }),
    'C:\\Users\\Public\\mixdog-askpass-k'
  );
  assert.equal(
    await resolvePlainDir(okRun, '/home/김철수/.config/Mixdog', 'askpass', { platform: 'linux', env: {} }),
    '/home/김철수/.config/Mixdog/askpass'
  );
});

test('each session writes its helper into its own random folder, locked to the user before anything is written, and removes it on close', async () => {
  const helperDir = makeTempDirSync('askpass-base');
  const seen = [];
  const run = async (command, args) => {
    // At lock time the folder must hold no helper file yet.
    seen.push([command, args[0], (await readdir(args[0])).filter((name) => name.startsWith('askpass')).length]);
    return { code: 0, stdout: '', stderr: '' };
  };
  const ask = async () => 'x';
  const first = await startAskpassSession({ ask, helperDir, run, user: 'me' });
  const second = await startAskpassSession({ ask, helperDir, run, user: 'me' });
  try {
    const dirOf = (s) => s.env.SSH_ASKPASS.replace(/[\\/]askpass\.\w+$/, '');
    assert.notEqual(dirOf(first), dirOf(second));
    assert.match(dirOf(first).slice(helperDir.length + 1), /^mxa-/);
    if (process.platform === 'win32') {
      assert.deepEqual(
        seen.slice(0, 2).map(([command, folder, files]) => [command, folder, files]),
        [
          ['icacls', helperDir, 0],
          ['icacls', dirOf(first), 0],
        ]
      );
    }
  } finally {
    await first.close();
    assert.equal((await readdir(helperDir)).length, 1, 'only the other session’s folder is left');
    await second.close();
    assert.equal((await readdir(helperDir)).length, 0);
  }
  await assert.rejects(
    startAskpassSession({
      ask,
      helperDir,
      platform: 'win32',
      run: async () => ({ code: 5, stdout: '', stderr: 'Access is denied.' }),
    }),
    /Access is denied/,
    'a folder that cannot be locked is never used'
  );
  assert.equal((await readdir(helperDir)).length, 0);
});
const EXEC = ['-o', 'BatchMode=yes', '-o', 'ControlMaster=no', '-o', 'ControlPath=none', '-T', '--', 'root@h', 'true'];
const TUNNEL = [
  '-o',
  'BatchMode=yes',
  '-o',
  'ControlMaster=no',
  '-o',
  'ControlPath=none',
  '-N',
  '-L',
  '1:2:3',
  '--',
  'root@h',
];
const live = (extra = {}) => ({
  env: { SSH_ASKPASS: 'H:askpass.sh', MIXDOG_ASKPASS_TOKEN: 't' },
  controlDir: null,
  closed: false,
  cancelled: false,
  close: async () => undefined,
  ...extra,
});

test('every ssh reads Mixdog’s own config (-F) unless the caller passes one', () => {
  const own = prepareSshSpawn('ssh', EXEC, undefined, 'linux', {}, '/data/ssh/config');
  assert.deepEqual(own.args.slice(0, 2), ['-F', '/data/ssh/config']);
  assert.deepEqual(own.args.slice(2), EXEC);
  assert.deepEqual(prepareSshSpawn('ssh', ['-F', 'mine', ...EXEC], undefined, 'linux', {}, '/data/ssh/config').args, [
    '-F',
    'mine',
    ...EXEC,
  ]);
  assert.deepEqual(prepareSshSpawn('ssh-keyscan', ['-p', '22'], undefined, 'linux', {}, '/data/ssh/config').args, [
    '-p',
    '22',
  ]);
});

test('ssh runs BatchMode with no helper unless an interactive retry is running', () => {
  const plain = prepareSshSpawn('ssh', EXEC, undefined, 'linux', { PATH: 'x' });
  assert.deepEqual(plain.args, EXEC);
  assert.equal(plain.env, undefined);
  const closed = prepareSshSpawn('ssh', EXEC, { askpass: live({ closed: true }) }, 'linux');
  assert.deepEqual(closed.args, EXEC);
  assert.equal(closed.env, undefined, 'a session that ended no longer lends its helper to later reconnects');
  const other = prepareSshSpawn('ssh-keyscan', ['-p', '22'], { askpass: live() }, 'linux');
  assert.deepEqual([other.args, other.env], [['-p', '22'], undefined]);
});

test('during the interactive retry ssh gets the helper, BatchMode off and a display', () => {
  const run = prepareSshSpawn('ssh', EXEC, { askpass: live() }, 'win32', { PATH: 'x' });
  assert.deepEqual(
    run.args.filter((arg) => arg.startsWith('BatchMode')),
    ['BatchMode=no']
  );
  assert.equal(run.env.SSH_ASKPASS, 'H:askpass.sh');
  assert.equal(run.env.SSH_ASKPASS_REQUIRE, 'force');
  assert.equal(run.env.DISPLAY, 'localhost:0');
  assert.equal(run.env.PATH, 'x');
  assert.equal(prepareSshSpawn('ssh', EXEC, { askpass: live() }, 'win32', { DISPLAY: ':1' }).env.DISPLAY, ':1');
  assert.ok(run.args.includes('ControlPath=none'), 'Windows OpenSSH has no connection sharing');
});

test('macOS/Linux share one login across the attempt’s short commands; the tunnel only joins it', () => {
  const askpass = live({ controlDir: '/tmp/mxa-abc' });
  const exec = prepareSshSpawn('ssh', EXEC, { askpass }, 'linux');
  assert.ok(exec.args.includes('ControlMaster=auto'));
  assert.ok(exec.args.includes('ControlPath=/tmp/mxa-abc/%C'));
  assert.ok(exec.args.includes('ControlPersist=30'));
  const tunnel = prepareSshSpawn('ssh', TUNNEL, { askpass }, 'darwin');
  assert.ok(tunnel.args.includes('ControlMaster=no'), 'a -N tunnel never becomes a background master');
  assert.ok(tunnel.args.includes('ControlPath=/tmp/mxa-abc/%C'));
  assert.equal(
    tunnel.args.some((arg) => arg.startsWith('ControlPersist')),
    false
  );
});

test('the server’s key file is passed with -i, even when its path has spaces or non-ASCII characters', () => {
  const file = 'C:\\Users\\김 철수\\.ssh\\id work';
  const run = prepareSshSpawn('ssh', EXEC, { settings: { identityFile: file } }, 'win32');
  assert.deepEqual(run.args.slice(0, 4), ['-i', file, '-o', 'IdentitiesOnly=yes']);
  assert.deepEqual(run.args.slice(4), EXEC);
  assert.equal(prepareSshSpawn('ssh', EXEC, { settings: {} }, 'win32').args.includes('-i'), false);
});
