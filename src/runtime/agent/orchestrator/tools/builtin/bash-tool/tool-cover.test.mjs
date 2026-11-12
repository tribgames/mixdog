// Every form the shell guard covers is run twice on a fixture tree — as the
// shell command and as the replacement call it names — and the information
// each returns (the same lines, rows or entries) must be the same.
import '../../../../../../../scripts/lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';

const { coveringToolCalls } = await import('./tool-cover.mjs');
const { executeBuiltinTool } = await import('../../builtin.mjs');
const { resolveShellFor } = await import('../shell-runtime.mjs');

const root = realpathSync(mkdtempSync(join(tmpdir(), 'mixdog-tool-cover-')));
after(() => rmSync(root, { recursive: true, force: true }));
const numbered = (count, suffix = '') => Array.from({ length: count }, (_, i) => `row ${i + 1}${suffix}`).join('\n') + '\n';
mkdirSync(join(root, 'sub'));
mkdirSync(join(root, 'dir', 'inner'), { recursive: true });
writeFileSync(join(root, 'small.txt'), 'alpha\nFoo bar\nomega foo\n');
writeFileSync(join(root, 'sub', 'nested.txt'), 'nested foo\n');
writeFileSync(join(root, 'dir', 'one.txt'), '1\n');
writeFileSync(join(root, 'dir', 'inner', 'deep.txt'), 'd\n');
writeFileSync(join(root, 'dir', 'two.log'), '2\n');
writeFileSync(join(root, 'long.log'), numbered(40, ' foo'));
writeFileSync(join(root, 'nofinal.txt'), 'first\nsecond\nlast');
writeFileSync(join(root, 'crlf.txt'), 'a1\r\nb2 foo\r\nc3\r\n');
// More matching lines than the grep tool's default page of 250.
writeFileSync(join(root, 'many.txt'), numbered(300, ' foo'));
spawnSync('git', ['init', '-q'], { cwd: root });

const lines = (text) => String(text).replace(/\r|\x1b\[[0-9;]*m/g, '').split('\n').filter((line) => line !== '');
// Strip each tool's framing so only the information is compared.
const FRAMING = {
  read: (text) => lines(text).filter((line) => !/^\[lines \d+-\d+(?: of \d+.*)?\]$/.test(line)),
  grep: (text) => lines(text).map((line) => line.replace(/^\d+:/, '')),
  list: (text) => lines(text).map((line) => line.split('\t')[0]).sort(),
};
const shellRows = {
  read: lines,
  grep: (text) => lines(text).map((line) => line.replace(/^.*?:\d+:|^\d+:/, '')),
  list: (text) => lines(text).sort(),
};

const SHELLS = { posix: resolveShellFor('bash'), powershell: resolveShellFor('powershell') };
const runShell = (shellType, command) => {
  const { shell, shellArgs } = SHELLS[shellType];
  const run = spawnSync(shell, [...shellArgs, command], { cwd: root, encoding: 'utf8' });
  assert.equal(run.status, 0, `${command}: ${run.stderr}`);
  return run.stdout;
};

// [shell, command, the tool it is replaced by]
const FORMS = [
  ['posix', 'cat small.txt', 'read'],
  ['posix', 'cat nofinal.txt', 'read'],
  ['posix', 'cat crlf.txt', 'read'],
  ['posix', 'head -n 5 long.log', 'read'],
  ['posix', 'head -3 long.log', 'read'],
  ['posix', 'head long.log', 'read'],
  ['posix', 'tail -n 4 long.log', 'read'],
  ['posix', 'tail -4 long.log', 'read'],
  ['posix', 'tail long.log', 'read'],
  ['posix', 'tail -n 2 nofinal.txt', 'read'],
  ['posix', 'tail -n 400 crlf.txt', 'read'],
  ['posix', 'tail -n +2 small.txt', 'read'],
  ['posix', 'cat long.log | head -n 6', 'read'],
  ['posix', 'cat long.log | tail -n 6', 'read'],
  ['posix', 'grep foo small.txt', 'grep'],
  ['posix', 'grep -i foo small.txt', 'grep'],
  ['posix', 'grep -n foo long.log', 'grep'],
  ['posix', 'grep "Foo bar" small.txt', 'grep'],
  ['posix', 'rg foo crlf.txt', 'grep'],
  ['posix', 'cat crlf.txt | grep foo', 'grep'],
  ['posix', 'ls dir', 'list'],
  ['posix', 'ls dir/inner', 'list'],
  ['powershell', 'Get-Content small.txt', 'read'],
  ['powershell', 'gc nofinal.txt', 'read'],
  ['powershell', 'type crlf.txt', 'read'],
  ['powershell', 'Get-Content -Path long.log -TotalCount 5', 'read'],
  ['powershell', 'Get-Content long.log -First 3', 'read'],
  ['powershell', 'Get-Content long.log -Head 3', 'read'],
  ['powershell', 'Get-Content -LiteralPath long.log -Tail 4', 'read'],
  ['powershell', 'Get-Content long.log -Last 4', 'read'],
  ['powershell', 'cat long.log | Select-Object -First 6', 'read'],
  ['powershell', 'gc long.log | Select-Object -Last 6', 'read'],
  ['powershell', 'Select-String foo small.txt', 'grep'],
  ['powershell', 'Select-String -Pattern foo -Path long.log', 'grep'],
  ['powershell', 'Select-String -CaseSensitive foo small.txt', 'grep'],
  ['powershell', 'gc crlf.txt | Select-String foo', 'grep'],
  ['posix', 'grep foo many.txt', 'grep'],
  ['powershell', 'Select-String foo many.txt', 'grep'],
];

for (const [shellType, command, tool] of FORMS) {
  test(`${shellType}: ${command} returns what ${tool} returns`, { skip: SHELLS[shellType] ? false : `no ${shellType} shell` }, async () => {
    const calls = coveringToolCalls(command, shellType, { cwd: root });
    assert.ok(calls, 'covered');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].tool, tool);
    const replaced = String(await executeBuiltinTool(calls[0].tool, calls[0].args, root));
    const expected = shellRows[tool](runShell(shellType, command));
    const got = FRAMING[tool](replaced);
    assert.deepEqual(got, expected, `${command} → ${JSON.stringify(calls[0])}`);
  });
}

test('only one statement is ever covered: a join keeps conditions separate tool calls do not', () => {
  for (const command of [
    // The search finds nothing and fails, so the shell never runs the second statement.
    'grep NOMATCH small.txt && head -n 2 long.log',
    'head -n 2 long.log && ls dir',
    'head -n 2 long.log; ls dir',
    'head -n 2 long.log\nls dir',
    'head -n 2 long.log || ls dir',
    'head -n 2 long.log; sort long.log',
  ]) {
    assert.equal(coveringToolCalls(command, 'posix', { cwd: root }), null, command);
  }
});

test('a dangling operator is a syntax error in the shell, so the command is not covered', () => {
  for (const command of ['cat small.txt &&', 'cat small.txt |', 'cat small.txt ||', 'cat small.txt &', 'cat small.txt | head -n 2 |']) {
    assert.equal(coveringToolCalls(command, 'posix', { cwd: root }), null, command);
  }
  assert.equal(coveringToolCalls('Get-Content small.txt |', 'powershell', { cwd: root }), null);
});

test('a whole file is covered up to the read window, counting a last line without its newline', () => {
  writeFileSync(join(root, 'edge500.txt'), numbered(500));
  writeFileSync(join(root, 'edge501.txt'), `${numbered(500)}last`);
  assert.deepEqual(coveringToolCalls('cat edge500.txt', 'posix', { cwd: root }), [{ tool: 'read', args: { file_path: 'edge500.txt' } }]);
  assert.equal(coveringToolCalls('cat edge501.txt', 'posix', { cwd: root }), null);
});

test('a redirect changes what the command returns, so it is not covered', () => {
  for (const command of ['cat small.txt > /dev/null', 'cat small.txt 2>/dev/null', 'head -n 2 long.log 2>&1', 'cat small.txt > out.txt']) {
    assert.equal(coveringToolCalls(command, 'posix', { cwd: root }), null, command);
  }
  for (const command of ['Get-Content small.txt 2>$null', 'Get-Content small.txt > $null', 'gc small.txt *> out.txt']) {
    assert.equal(coveringToolCalls(command, 'powershell', { cwd: root }), null, command);
  }
});

test('no git command is covered: the git tool answers in its own form', () => {
  for (const command of ['git status', 'git status --short', 'git log --oneline -5', 'git diff --stat', 'git ls-files', 'git diff --quiet']) {
    assert.equal(coveringToolCalls(command, 'posix', { cwd: root }), null, command);
    assert.equal(coveringToolCalls(command, 'powershell', { cwd: root }), null, command);
  }
});

test('values outside the replacement schema are not covered', () => {
  for (const command of ['head -n 0 long.log', 'head -n 501 long.log', 'tail -n 100000 long.log', 'grep foo long.log -C 201']) {
    assert.equal(coveringToolCalls(command, 'posix', { cwd: root }), null, command);
  }
});

test('paths the tools would read differently are not covered', () => {
  const outside = join(tmpdir(), 'mixdog-tool-cover-missing.txt');
  for (const command of [
    'cat /dev/zero',
    'cat /dev/stdin',
    `cat ${outside}`,
    'cat small.txt:2',
    'cat "small.txt#L2"',
    'cat ~/small.txt',
    'cat sm*.txt',
    'cat dir',
    'ls long.log',
  ]) {
    assert.equal(coveringToolCalls(command, 'posix', { cwd: root }), null, command);
  }
  writeFileSync(join(root, 'big.txt'), numbered(600));
  assert.equal(coveringToolCalls('cat big.txt', 'posix', { cwd: root }), null, 'a file the read tool pages');
  assert.ok(coveringToolCalls('head -n 5 big.txt', 'posix', { cwd: root }));
  writeFileSync(join(root, 'bin.dat'), Buffer.from([0, 1, 2, 3]));
  assert.equal(coveringToolCalls('head -n 2 bin.dat', 'posix', { cwd: root }), null, 'binary');
});
