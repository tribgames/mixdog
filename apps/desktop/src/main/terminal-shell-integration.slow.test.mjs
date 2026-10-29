// The integration scripts run in the real shells installed here; a shell
// that is not installed skips its test.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { planShellIntegration } from './terminal-shell-integration.ts';

const posix = (file) => file.replace(/\\/g, '/');
const windows = process.platform === 'win32';
const onPath = (name) => spawnSync(windows ? 'where' : 'which', [name], { encoding: 'utf8' }).status === 0;
const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe';
const bash = windows ? (existsSync(gitBash) ? gitBash : null) : existsSync('/bin/bash') ? '/bin/bash' : null;
const marker = (body) => `\x1b]697;${body}\x07`;

/**
 * Run `file` with `input` on stdin; resolves with stdout + stderr.
 *
 * A `-c` shell never reads stdin and can exit before we close the pipe, so the
 * write fails with EPIPE on a fast machine (seen on Linux arm64). That alone
 * is not a failure: the assertions on the output decide. It is a failure when
 * the shell also exited abnormally, and then the error carries the exit code
 * and the shell's output.
 */
function run(file, args, env, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { env, windowsHide: true });
    let out = '';
    let stdinError = null;
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (out += chunk));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`timed out; output so far: ${JSON.stringify(out)}`));
    }, 30_000);
    child.on('error', reject);
    child.stdin.on('error', (error) => {
      stdinError = error;
    });
    // 'close' fires after the output streams drain; 'exit' may precede the last chunk.
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (stdinError && (stdinError.code !== 'EPIPE' || code !== 0)) {
        reject(
          new Error(`${stdinError.message}; exit code ${code}, signal ${signal}; output: ${JSON.stringify(out)}`, {
            cause: stdinError,
          })
        );
        return;
      }
      resolve(out);
    });
    child.stdin.end(input);
  });
}

async function tempRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'mixdog-shell-real-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'home');
  await mkdir(home);
  return { root, home };
}

for (const shell of ['pwsh', 'powershell']) {
  test(`${shell}: markers are written and the user's prompt still sees $?`, { skip: !onPath(shell) && `${shell} is not installed` }, async () => {
    const plan = planShellIntegration({ path: shell }, null);
    const integration = Buffer.from(plan.args[2], 'base64').toString('utf16le');
    // The user's prompt (as a profile would define it), PSReadLine as an
    // interactive session has it, then a failing and a succeeding command.
    const script = [
      'function prompt { "user-sees=$?;" }',
      'Import-Module PSReadLine',
      integration,
      'Get-Item mixdog-no-such-item -ErrorAction SilentlyContinue',
      'prompt',
      '$null = 1',
      'prompt',
    ].join('\n');
    const encoded = Buffer.from(script, 'utf16le').toString('base64');
    const out = await run(shell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], process.env, '');
    assert.ok(
      out.includes(`${marker('D;1')}${marker('P')}user-sees=False;`),
      `failed status preserved: ${JSON.stringify(out)}`
    );
    assert.ok(out.includes(`${marker('D;0')}${marker('P')}user-sees=True;`), JSON.stringify(out));
  });
}

const BASH_PROBE = [
  'shopt -q login_shell && echo LOGIN=yes || echo LOGIN=no',
  'echo "PROFILE=${PROFILE_READ:-no} RC=${RC_READ:-no}"',
  'false',
  'exit',
  '',
].join('\n');

async function bashHome(t) {
  const dirs = await tempRoot(t);
  await writeFile(join(dirs.home, '.bash_profile'), 'PROFILE_READ=yes\n');
  await writeFile(join(dirs.home, '.bashrc'), 'RC_READ=yes\n');
  return dirs;
}

const bashEnv = (home, plan) => ({ ...process.env, HOME: posix(home), ...plan.env });

test('bash --login stays a genuine login shell and reports markers', { skip: !bash && 'bash is not installed' }, async (t) => {
  const { root, home } = await bashHome(t);
  const plan = planShellIntegration({ path: bash, args: ['--login', '-i'] }, root);
  assert.equal(plan.integration, 'bash');
  const out = await run(plan.path, plan.args, bashEnv(home, plan), BASH_PROBE);
  assert.match(out, /LOGIN=yes/);
  assert.match(out, /PROFILE=yes RC=no/, 'the login files bash itself reads');
  assert.ok(out.includes(marker('P')), JSON.stringify(out));
  assert.ok(out.includes(marker('C')), JSON.stringify(out));
  assert.ok(out.includes(marker('D;1')), JSON.stringify(out));
});

test('bash --login whose profile replaces PROMPT_COMMAND stays unintegrated', { skip: !bash && 'bash is not installed' }, async (t) => {
  const { root, home } = await bashHome(t);
  await writeFile(join(home, '.bash_profile'), "PROMPT_COMMAND='true'\n");
  const plan = planShellIntegration({ path: bash, args: ['--login', '-i'] }, root);
  const out = await run(plan.path, plan.args, bashEnv(home, plan), BASH_PROBE);
  assert.match(out, /LOGIN=yes/);
  assert.ok(!out.includes('\x1b]697;'), JSON.stringify(out));
});

test('non-login bash reads its rc files through the init file and reports markers', { skip: !bash && 'bash is not installed' }, async (t) => {
  const { root, home } = await bashHome(t);
  const plan = planShellIntegration({ path: bash }, root);
  const out = await run(plan.path, plan.args, bashEnv(home, plan), BASH_PROBE);
  assert.match(out, /LOGIN=no/);
  assert.match(out, /PROFILE=no RC=yes/);
  assert.ok(out.includes(marker('D;1')), JSON.stringify(out));
});

// The zsh startup files' ZDOTDIR handoff, in the order zsh reads them
// (.zshenv, .zprofile for a login shell, .zshrc). That part is plain POSIX
// test-and-assign syntax, so it runs in real zsh when installed, else bash.
const zsh = !windows && onPath('zsh') ? 'zsh' : bash;
const ZSH_PROBE = [
  'source "$ZDOTDIR/.zshenv"',
  'source "$ZDOTDIR/.zprofile"',
  'source "$ZDOTDIR/.zshrc"',
  'echo "Z=${ZDOTDIR-unset} RC=${RC_READ:-no} FLAG=${MIXDOG_ZDOTDIR_UNSET-gone}"',
].join('\n');

async function zshRun(t, userZshenv, launchZdotdir) {
  const { root, home } = await tempRoot(t);
  const config = join(home, 'cfg');
  await mkdir(config);
  if (userZshenv) await writeFile(join(home, '.zshenv'), userZshenv);
  await writeFile(join(home, '.zshrc'), 'RC_READ=home\n');
  await writeFile(join(config, '.zshrc'), 'RC_READ=cfg\n');
  const baseEnv = { HOME: posix(home), ...(launchZdotdir ? { ZDOTDIR: posix(config) } : {}) };
  const plan = planShellIntegration({ path: '/bin/zsh', args: ['-l'] }, root, baseEnv, 'linux');
  const env = { ...process.env, ...baseEnv, ...plan.env, ZDOTDIR: posix(plan.env.ZDOTDIR) };
  return { out: await run(zsh, ['-c', ZSH_PROBE], env, ''), config: posix(config) };
}

test('zsh: a ZDOTDIR set by the user’s .zshenv survives the handoff', { skip: !zsh && 'neither zsh nor bash is installed' }, async (t) => {
  // (MSYS bash rewrites HOME to its own spelling: match the user's path tail.)
  const { out } = await zshRun(t, 'ZDOTDIR=$HOME/cfg\n', false);
  assert.match(out, /Z=\S+\/home\/cfg RC=cfg FLAG=gone/);
});

test('zsh: ZDOTDIR unset at launch and never set by the user ends unset', { skip: !zsh && 'neither zsh nor bash is installed' }, async (t) => {
  const { out } = await zshRun(t, null, false);
  assert.match(out, /Z=unset RC=home FLAG=gone/);
});

test('zsh: a ZDOTDIR given at launch is handed back', { skip: !zsh && 'neither zsh nor bash is installed' }, async (t) => {
  const { out, config } = await zshRun(t, null, true);
  assert.ok(out.includes(`Z=${config} RC=cfg FLAG=gone`), out);
});
