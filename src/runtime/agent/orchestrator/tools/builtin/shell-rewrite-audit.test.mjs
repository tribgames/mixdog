// Reproductions for the places where the shell tool rewrites or re-parses the
// agent's command before running it. Each case is a command the rewrite used to
// change when it should have run unchanged (or changed wrongly).
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';

import { checkExecPolicyMessage } from '../bash-policy-scan.mjs';
import { maybeRewriteWmicProcessCommand } from '../shell-policy.mjs';
import { _maybeEncodePowerShellCommand } from '../shell-powershell.mjs';
import { gitCommandMutates } from './git-command-policy.mjs';
import { _gitCommandInternals } from './git-command-tool.mjs';
import {
  analyzeShellCommandEffects,
  buildPowerShellFilterTeePlan,
  planInlineScriptHoist,
  planLongInlineScriptFileTransport,
  planLongShellScriptFileTransport,
  preflightPowerShellHygiene,
  preflightShellLargeFileProbe,
  shellSplitPipelineSegments,
  shellSplitSegments,
  shellTokenize,
} from './shell-analysis.mjs';
import { commandNeedsShell, planDirectExeSpawn, tokenizeDirectArgv } from './shell-direct-exe.mjs';

const WIN = { platform: 'win32', shellType: 'powershell', env: {} };

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-rewrite-audit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// ── shell-direct-exe: tokenizer + direct spawn ──────────────────────────────

test('direct argv: a PowerShell doubled single quote is a literal quote', () => {
  assert.deepEqual(tokenizeDirectArgv(`node -e 'it''s'`), ['node', '-e', "it's"]);
  assert.deepEqual(tokenizeDirectArgv(`git commit -m 'a ''b'' c'`), ['git', 'commit', '-m', "a 'b' c"]);
  assert.deepEqual(tokenizeDirectArgv(`x ''`), ['x', '']);
  assert.deepEqual(tokenizeDirectArgv('git commit -m "say \\"hi\\""'), ['git', 'commit', '-m', 'say "hi"']);
});

test('direct argv, strict: forms PowerShell parses differently decline instead of guessing', () => {
  for (const command of [`node 'a'b`, `node "a"'b'`, `node 'a b'c`, 'node "a\\"b c\\""']) {
    assert.equal(tokenizeDirectArgv(command, { strict: true }), null, command);
  }
  assert.deepEqual(tokenizeDirectArgv(`node a"b c"d 'x y' ""`, { strict: true }), ['node', 'ab cd', 'x y', '']);
  assert.deepEqual(tokenizeDirectArgv(`node "a b" 'it''s'`, { strict: true }), ['node', 'a b', "it's"]);
});

test('commandNeedsShell: a bare tilde or splat is expanded by PowerShell, not the program', () => {
  for (const command of ['node x ~', 'node x ~/y', 'node x @args'])
    assert.equal(commandNeedsShell(command), true, command);
  for (const command of ['node x a~b', `node x '~'`, 'git log HEAD~1', 'node x a@b']) {
    assert.equal(commandNeedsShell(command), false, command);
  }
});

test('direct spawn: resolution and arguments match what PowerShell would run', (t) => {
  const bin = tempDir(t);
  writeFileSync(join(bin, 'node.exe'), '');
  const opts = { ...WIN, cwd: bin, pathValue: bin };
  assert.deepEqual(planDirectExeSpawn(`node a 'it''s'`, opts)?.argv, ['a', "it's"]);
  assert.deepEqual(planDirectExeSpawn(`node a "b c"`, opts)?.argv, ['a', 'b c']);
  for (const command of [`node a 'x'y`, 'node a ~', 'node a @list', 'node a "x\\"y z\\""']) {
    assert.equal(planDirectExeSpawn(command, opts), null, command);
  }
});

test('direct spawn: the working directory is not on the command search path', (t) => {
  const project = tempDir(t);
  const bin = tempDir(t);
  writeFileSync(join(project, 'planted.exe'), '');
  writeFileSync(join(bin, 'real.exe'), '');
  assert.equal(planDirectExeSpawn('planted a', { ...WIN, cwd: project, pathValue: bin }), null);
  assert.equal(
    planDirectExeSpawn('planted a', { ...WIN, cwd: project, pathValue: project })?.exe,
    join(project, 'planted.exe')
  );
  assert.equal(planDirectExeSpawn('real a', { ...WIN, cwd: project, pathValue: bin })?.exe, join(bin, 'real.exe'));
});

test('direct spawn: a shim earlier on PATH, or a .com/.ps1 beside the exe, keeps the shell', (t) => {
  const first = tempDir(t);
  const second = tempDir(t);
  writeFileSync(join(first, 'tool.cmd'), '');
  writeFileSync(join(second, 'tool.exe'), '');
  const pathValue = [first, second].join(delimiter);
  assert.equal(planDirectExeSpawn('tool a', { ...WIN, cwd: second, pathValue }), null);
  assert.equal(planDirectExeSpawn('tool a', { ...WIN, cwd: second, pathValue: second })?.exe, join(second, 'tool.exe'));
  const mixed = tempDir(t);
  writeFileSync(join(mixed, 'both.exe'), '');
  writeFileSync(join(mixed, 'both.ps1'), '');
  assert.equal(planDirectExeSpawn('both a', { ...WIN, cwd: mixed, pathValue: mixed }), null);
  // `.cmd` beside the exe in the SAME directory: PATHEXT ranks .exe first.
  const same = tempDir(t);
  writeFileSync(join(same, 'pair.exe'), '');
  writeFileSync(join(same, 'pair.cmd'), '');
  assert.equal(planDirectExeSpawn('pair a', { ...WIN, cwd: same, pathValue: same })?.exe, join(same, 'pair.exe'));
});

test('direct spawn: names PowerShell aliases (fc) are not resolved to the same-named exe', (t) => {
  const bin = tempDir(t);
  writeFileSync(join(bin, 'fc.exe'), '');
  assert.equal(planDirectExeSpawn('fc a b', { ...WIN, cwd: bin, pathValue: bin }), null);
});

// ── shell-analysis: inline-script hoist ─────────────────────────────────────

test('hoist: an inline script that is only text (string, here-string, comment, heredoc) is left alone', () => {
  const body = `node -e "console.log(1)"`;
  for (const [command, shellType] of [
    [`@'\n${body}\n'@ | Set-Content README.md`, 'powershell'],
    [`Write-Output 'usage:\n${body}\nend'`, 'powershell'],
    [`# ${body}\nGet-Date`, 'powershell'],
    [`cat <<'EOF' > README.md\n${body}\nEOF`, 'posix'],
    [`echo 'usage:\n${body}\nend'`, 'posix'],
    [`# ${body}\ndate`, 'posix'],
  ]) {
    assert.equal(planInlineScriptHoist(command, { shellType }), null, command);
  }
  for (const shellType of ['powershell', 'posix']) {
    assert.ok(planInlineScriptHoist(body, { shellType }), shellType);
    assert.ok(planInlineScriptHoist(`cd src && ${body}`, { shellType }), shellType);
    assert.ok(planInlineScriptHoist(`echo 'it''s' ; ${body}`, { shellType }), shellType);
  }
});

test('hoist: node/python run by another program (docker, ssh, wsl, ts-node) is not hoisted to a host path', () => {
  for (const command of [
    `docker run --rm node:22 node -e "console.log(1)"`,
    `docker exec app python -c "print(1)"`,
    `ssh host node -e "console.log(1)"`,
    `wsl python3 -c "print(1)"`,
    `npx ts-node -e "console.log(1)"`,
  ]) {
    for (const shellType of ['powershell', 'posix']) {
      assert.equal(planInlineScriptHoist(command, { shellType }), null, command);
    }
  }
  assert.ok(planInlineScriptHoist(`/usr/bin/node -e "console.log(1)"`, { shellType: 'posix' }));
  assert.ok(planInlineScriptHoist(`FOO=1 node -e "console.log(1)"`, { shellType: 'posix' }));
  assert.ok(planInlineScriptHoist(`& node -e "console.log(1)"`, { shellType: 'powershell' }));
});

test('hoist: the replacement lands on the matched invocation, not on an earlier look-alike', () => {
  const plan = planInlineScriptHoist(`xnode -e "console.log(1)"; node -e "console.log(1)"`, { shellType: 'posix' });
  assert.equal(plan.replace('/tmp/a.cjs'), `xnode -e "console.log(1)"; node "/tmp/a.cjs"`);
});

test('hoist: python keeps -c when an import would resolve from the working directory', () => {
  for (const command of [
    `python -c "import helper; helper.run()"`,
    `python3 -c "from pkg.sub import thing"`,
    `python -c "from . import sibling"`,
    `python -c "import os\nimport helper"`,
    `python -c "__import__('helper')"`,
    `python -c "if True: import helper"`,
  ]) {
    assert.equal(planInlineScriptHoist(command, { shellType: 'posix' }), null, command);
  }
  for (const command of [
    `python -c "import os, json; print(os.getcwd())"`,
    `python3 -c "from os import path; print(path.sep)"`,
    `py -c "import sys; print(sys.version_info[0])"`,
    `python -c "print('한글 테스트')"`,
  ]) {
    assert.ok(planInlineScriptHoist(command, { shellType: 'posix' }), command);
  }
});

test('hoist: node keeps -e for ESM syntax and top-level await a .cjs file would reject', () => {
  for (const command of [
    `node -e "import fs from 'node:fs'; console.log(fs.existsSync('.'))"`,
    `node -e "await Promise.resolve(1); console.log(2)"`,
    // An `async` elsewhere in the body does not make a top-level await safe.
    `node -e "async function f(){}; await Promise.resolve(1); console.log(42)"`,
    `node -e "const g = async () => 1; const v = await g(); console.log(v)"`,
    `node -e "export const x = 1"`,
  ]) {
    assert.equal(planInlineScriptHoist(command, { shellType: 'posix' }), null, command);
  }
  for (const command of [
    `node -e "(async () => { await Promise.resolve(1); console.log(2) })()"`,
    `node -e "async function f(){ await Promise.resolve(1); console.log(2) } f()"`,
    `node -e "import('node:fs').then(console.log)"`,
    `node --input-type=module -e "import fs from 'node:fs'; console.log(fs.existsSync('.'))"`,
  ]) {
    assert.ok(planInlineScriptHoist(command, { shellType: 'posix' }), command);
  }
});

test('hoist: PowerShell ends a double-quoted string at a typographic quote, so the body is not what -e gets', () => {
  const command = `node -e "console.log('\u201Cx\u201D')"`;
  assert.equal(planInlineScriptHoist(command, { shellType: 'powershell' }), null);
  assert.ok(planInlineScriptHoist(command, { shellType: 'posix' }));
});

// ── shell-analysis: long inline transport ───────────────────────────────────

const FILLER = 'x'.repeat(25_000);
const longPlan = (command, shellType = 'powershell') =>
  planLongInlineScriptFileTransport(command, { platform: 'win32', shellType });

test('long inline transport: only a body the shell would pass through verbatim is moved to a file', () => {
  const body = `console.log(1); // ${FILLER}`;
  for (const command of [
    `node -e "${body}" extra`,
    `node -e "${body}""x"`,
    `node -e "${body}"suffix`,
    `node -e '${body}' --flag`,
    `node -e "console.log('$HOME'); // ${FILLER}"`,
    `node -e "console.log(\\"x\\"); // ${FILLER}"`,
    `node -e "console.log('\u201Cx\u201D'); // ${FILLER}"`,
    `@'\nnode -e "${body}"\n'@ | Set-Content README.md`,
    `docker run --rm node:22 node -e "${body}"`,
  ]) {
    assert.equal(longPlan(command), null, command.slice(0, 80));
  }
  assert.equal(longPlan(`node -e "console.log('a\\\\b'); // ${FILLER}"`, 'posix'), null);
  const plan = longPlan(`Write-Host hi; node -e "${body}" | Out-String`);
  assert.equal(plan.body, body);
  assert.equal(plan.replace('C:\\t\\a.cjs'), 'Write-Host hi; node "C:/t/a.cjs" | Out-String');
  assert.equal(longPlan(`node -e 'console.log(''x''); // ${FILLER}'`).body, `console.log('x'); // ${FILLER}`);
});

// ── shell-analysis: whole-command .ps1 transport keeps the exit status ──────

const HAVE_PWSH = spawnSync('pwsh', ['-NoProfile', '-Command', '1'], { encoding: 'utf8' }).status === 0;

test('long PowerShell transport ends with the same exit code as running the command itself', {
  skip: !HAVE_PWSH,
}, (t) => {
  const dir = tempDir(t);
  const run = (script) => spawnSync('pwsh', ['-NoProfile', '-Command', script], { encoding: 'utf8' });
  for (const body of ['exit 5', 'Get-Item C:/nonexistent-mixdog-zzz', 'Write-Output hi', 'throw "boom"', '$false']) {
    const command = `${body}\n# ${'x'.repeat(24_000)}`;
    const plan = planLongShellScriptFileTransport(command, { platform: 'win32', shellType: 'powershell' });
    const file = join(dir, 'script.ps1');
    writeFileSync(file, `\uFEFF${plan.body}`, 'utf8');
    const direct = run(command);
    const moved = run(plan.replace(file));
    assert.equal(moved.status, direct.status, body);
    assert.equal(moved.stdout.trim(), direct.stdout.trim(), body);
  }
});

// ── shell-analysis: PowerShell hygiene preflight ────────────────────────────

test('hygiene: text inside a here-string is neither path-rewritten nor read for `&&`', () => {
  const script = "@'\nopen('/c/data/x.txt')  # it's && done\n'@ | python -";
  const result = preflightPowerShellHygiene(script, { shellType: 'powershell', shellName: 'powershell.exe' });
  assert.equal(result.block, null);
  assert.equal(result.command, script);
  assert.equal(result.note, null);
  const real = preflightPowerShellHygiene('Get-Content /c/Users/x.txt', { shellType: 'powershell', shellName: 'pwsh' });
  assert.equal(real.command, 'Get-Content C:\\Users\\x.txt');
});

// ── shell-analysis: filter-swallow tee rescue ───────────────────────────────

test('tee rescue does not rewrite a pipeline behind && or ||', () => {
  for (const command of [
    'Write-Output hi && node -e "console.log(1)" 2>&1 | Select-String 1',
    '$false || node -e "console.log(1)" 2>&1 | Select-String 1',
  ]) {
    assert.equal(buildPowerShellFilterTeePlan(command), null, command);
  }
  assert.ok(buildPowerShellFilterTeePlan('node -e "console.log(1)" 2>&1 | Select-String 1'));
  assert.ok(buildPowerShellFilterTeePlan('Write-Output hi; node -e "console.log(1)" 2>&1 | Select-String 1'));
});

// ── shell-analysis: tokenizer / segment splitter ────────────────────────────

test('shell tokenizer keeps Windows path backslashes and bash escapes apart', () => {
  assert.deepEqual(shellTokenize('cat "C:\\Users\\x\\big file.txt"'), ['cat', 'C:\\Users\\x\\big file.txt']);
  assert.deepEqual(shellTokenize('cat C:\\Users\\x\\big.txt'), ['cat', 'C:\\Users\\x\\big.txt']);
  assert.deepEqual(shellTokenize("cat 'C:\\x\\' y"), ['cat', 'C:\\x\\', 'y']);
  assert.deepEqual(shellTokenize('cat \\\\server\\share\\f.txt'), ['cat', '\\\\server\\share\\f.txt']);
  // Escapes a shell really needs stay escapes.
  assert.deepEqual(shellTokenize('rm a\\ b "c\\"d"'), ['rm', 'a b', 'c"d']);
});

test('segment splitter: a single-quoted string ending in a backslash is closed', () => {
  assert.deepEqual(shellSplitSegments("echo 'C:\\'; rm x"), ["echo 'C:\\'", 'rm x']);
  assert.deepEqual(shellSplitPipelineSegments("echo 'C:\\' | wc -l"), ["echo 'C:\\'", 'wc -l']);
  assert.deepEqual(shellSplitSegments('find . -exec rm {} \\; ; echo done'), ['find . -exec rm {} \\;', 'echo done']);
});

test('large-file probe and effects see a Windows path as written', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const dir = tempDir(t);
  const big = join(dir, 'big file.txt');
  writeFileSync(big, 'x'.repeat(60_000));
  for (const command of [`cat "${big}"`, `cat '${big}'`]) {
    assert.equal((await preflightShellLargeFileProbe(command, dir))?.path, big, command);
  }
  const effects = await analyzeShellCommandEffects(`rm "${big}"`, dir);
  assert.deepEqual(effects.paths, [big]);
});

// ── shell-analysis: effect classification ───────────────────────────────────

test('effects: a python run in a chain with a path mutator still invalidates everything', async () => {
  const cwd = process.cwd();
  assert.equal((await analyzeShellCommandEffects('mkdir out && python gen.py', cwd)).mutationMode, 'global');
  assert.equal(
    (await analyzeShellCommandEffects("touch a.txt && python3 -c \"open('b','w')\"", cwd)).mutationMode,
    'global'
  );
  const paths = await analyzeShellCommandEffects('touch a.txt && git status', cwd);
  assert.equal(paths.mutationMode, 'paths');
});

// ── shell-policy: wmic rewrite ──────────────────────────────────────────────

test('wmic rewrite only replaces a command that is a wmic call', () => {
  for (const command of [
    'rg "wmic process" src',
    'git commit -m "drop wmic process get usage"',
    `Select-String -Pattern 'wmic process' notes.md`,
    'echo wmic process get name',
  ]) {
    assert.equal(maybeRewriteWmicProcessCommand(command), null, command);
  }
  for (const command of [
    'wmic process get name,processid',
    'wmic.exe process where "name=\'node.exe\'" get processid',
    'cmd /c "wmic process get name"',
  ]) {
    assert.match(
      maybeRewriteWmicProcessCommand(command)?.command ?? '',
      /^powershell\.exe .*-EncodedCommand /,
      command
    );
  }
});

// ── exec policy: executable-syntax scan ─────────────────────────────────────

test('exec policy does not read the body of a PowerShell here-string as commands', () => {
  const body = "Set-Content a.mjs @'\nit's fine\n| pwsh\n'@";
  assert.equal(checkExecPolicyMessage(body), null);
  assert.equal(checkExecPolicyMessage(`${body} | Out-Null`), null);
  // A real pipe into a shell after the here-string is still refused.
  assert.match(checkExecPolicyMessage("@'\nWrite-Output 1\n'@ | pwsh") ?? '', /exec policy/);
});

// ── shell-powershell: pwsh -Command re-encoding ─────────────────────────────

const decodeEncoded = (command) => Buffer.from(/-EncodedCommand (\S+)/.exec(command)[1], 'base64').toString('utf16le');

test('pwsh -Command re-encoding leaves text that is not a command alone', {
  skip: process.platform !== 'win32',
}, () => {
  for (const command of [
    `@'\npwsh -Command "Get-Date"\n'@ | Set-Content README.md`,
    `Write-Output 'run: pwsh -c "Get-Date"'`,
    `# pwsh -c "Get-Date"\nGet-Date`,
    // More arguments follow the script: PowerShell appends them to the command text.
    `pwsh -Command "Write-Output a" "b"`,
  ]) {
    assert.equal(_maybeEncodePowerShellCommand(command), command, command);
  }
});

test('pwsh -Command re-encoding unescapes only the quote that wrapped the body', {
  skip: process.platform !== 'win32',
}, () => {
  const inner = `Write-Output 'it''s'`;
  assert.equal(decodeEncoded(_maybeEncodePowerShellCommand(`pwsh -NoProfile -Command "${inner}"`)), inner);
  const other = `Write-Output "a""b"`;
  assert.equal(decodeEncoded(_maybeEncodePowerShellCommand(`pwsh -Command '${other}'`)), other);
  assert.equal(
    decodeEncoded(_maybeEncodePowerShellCommand(`pwsh -Command "Write-Output ""a"" 'b'"`)),
    `Write-Output "a" 'b'`
  );
});

// ── git-command-tool: config scope rewrite ──────────────────────────────────

test('git config scope is added where git reads it for both the legacy and subcommand forms', (t) => {
  const repo = tempDir(t);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  const { localizeConfigPlan, parseCommand, prepare } = _gitCommandInternals;
  const run = (command) =>
    execFileSync('git', prepare(localizeConfigPlan(parseCommand(command, repo))).argv, {
      cwd: repo,
      encoding: 'utf8',
    }).trim();
  assert.equal(run('git config set user.name audit'), '');
  assert.equal(run('git config get user.name'), 'audit');
  assert.equal(run('git config user.email audit@example.com'), '');
  assert.equal(run('git config --get user.email'), 'audit@example.com');
  assert.match(run('git config list'), /user\.name=audit/);
  assert.match(run('git config --list'), /user\.email=audit@example\.com/);
});

// ── git-command-policy: read/write classification ───────────────────────────

test('git: a listing flag does not make a writing branch/tag call read-only', () => {
  for (const command of [
    'git tag -a v1 -m release',
    'git tag -a v1',
    'git branch -a -D old',
    'git branch -r -d origin/x',
    'git tag -l -d v1',
  ]) {
    assert.equal(gitCommandMutates({ command }), true, command);
  }
  for (const command of [
    'git tag',
    'git tag -l',
    'git tag --list "v*"',
    'git branch',
    'git branch -a',
    'git branch -r',
    'git branch --list',
  ]) {
    assert.equal(gitCommandMutates({ command }), false, command);
  }
});
