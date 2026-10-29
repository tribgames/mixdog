import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import '../../../../../../../scripts/test-data-dir.mjs';
import { displayShellCommand, POWERSHELL_UTF8_PREFIX } from '../../../../../shared/shell-display.mjs';
import { rewritePowerShellBashisms } from './bashism-rewrite.mjs';
import { prepareShellCommand } from './command-preflight.mjs';
import { executeBashTool } from '../bash-tool.mjs';

const rewrite = (command) => rewritePowerShellBashisms(command);
const same = (command) =>
  assert.equal(rewrite(command), null, `must pass through untouched: ${JSON.stringify(command)}`);
test('head/tail/wc pipelines are never rewritten (an existing head must keep its streaming semantics)', () => {
  for (const cmd of [
    'git log | head -20',
    'x | tail -n 5',
    'x |tail -n5',
    'x | head -n 3',
    'git ls-files | wc -l',
    'a 2>&1 | tail -5 2>&1; echo done',
    '(a | head -1)',
    'x | head -c 5',
    'x | tail -f log',
    'x | wc -c',
    'head -5 file.txt',
    'x | Select-Object -First 5',
    "echo 'a | head -5'",
    "echo @'\nx | head -3\n'@",
  ]) {
    same(cmd);
  }
});

test('quotes, here-strings, comments and escapes are never rewritten', () => {
  same('echo \'2>/dev/null\' "</dev/null"');
  same("echo @'\n2>/dev/null\n'@");
  same('echo hi # 2>/dev/null');
  same('echo `>/dev/null');
  same('git log "unterminated 2>/dev/null');
  same('echo "a $(x 2>/dev/null) b"');
  // Live code next to quoted lookalikes: only the live one is rewritten.
  assert.equal(rewrite('echo "it\'s 2>/dev/null" 2>/dev/null').command, 'echo "it\'s 2>/dev/null" 2>$null');
  assert.equal(rewrite('echo \'say "hi" 2>/dev/null\' 2>/dev/null').command, 'echo \'say "hi" 2>/dev/null\' 2>$null');
});

test('an already rewritten command is not rewritten again', () => {
  assert.equal(rewrite(rewrite('x 2>/dev/null').command), null);
});

test('/dev/null redirections become $null forms only outside quotes', () => {
  assert.equal(rewrite('a 2>/dev/null').command, 'a 2>$null');
  assert.equal(rewrite('a >/dev/null').command, 'a >$null');
  assert.equal(rewrite('a > /dev/null 2>&1').command, 'a >$null 2>&1');
  assert.equal(rewrite('a &>/dev/null').command, 'a *>$null');
  assert.equal(rewrite('a 2>>/dev/null').command, 'a 2>>$null');
  assert.equal(rewrite("ssh h 'ls' </dev/null").command, "ssh h 'ls'");
  assert.equal(rewrite('a 1>/dev/null; b 2>/dev/null').command, 'a 1>$null; b 2>$null');
  assert.equal(rewrite('a 2>/dev/null').note, '[rewritten: "2>/dev/null" → "2>$null"]');
  same('cat /dev/null');
  same('ls /dev/nullx');
  same('a 2>&1');
});

test('heredoc to python/node becomes a literal here-string piped in', () => {
  const py = rewrite("python - <<'EOF'\nprint(\"it's\")\nEOF");
  assert.equal(py.command, "@'\nprint(\"it's\")\n'@ | python -");
  assert.equal(py.note, `[rewritten: "python - <<'EOF'" → "@'…'@ | python -"]`);
  assert.equal(rewrite('python3 - <<"PY"\nx=1\nPY').command, "@'\nx=1\n'@ | python3 -");
  assert.equal(
    rewrite("cd src; node - <<'EOF'\nconsole.log(1)\nEOF\necho after").command,
    "cd src; @'\nconsole.log(1)\n'@ | node -\necho after"
  );
  assert.equal(rewrite("a && py -u - <<'E'\nprint(1)\nE").command, "a && @'\nprint(1)\n'@ | py -u -");
  assert.equal(rewrite("python <<'EOF'\nprint(1)\nEOF").command, "@'\nprint(1)\n'@ | python");
  assert.equal(rewrite("python - <<'EOF' 2>&1\nprint(1)\nEOF").command, "@'\nprint(1)\n'@ | python - 2>&1");
  assert.equal(rewrite("python - <<'EOF'\r\nprint(1)\r\nEOF\r\n").command, "@'\nprint(1)\n'@ | python -\n");
  // An unquoted delimiter is rewritten only when bash would expand nothing.
  assert.equal(rewrite('python - <<EOF\nprint(1)\nEOF').command, "@'\nprint(1)\n'@ | python -");
  // A trailing pipe on the opener line is carried over untouched.
  assert.equal(
    rewrite("node - <<'EOF' | tail -5\nconsole.log(1)\nEOF").command,
    "@'\nconsole.log(1)\n'@ | node - | tail -5"
  );
});

test('heredocs outside the exactly-safe shapes leave the whole command untouched', () => {
  same('python - <<EOF\nprint($x)\nEOF');
  same('python - <<EOF\nprint(`a`)\nEOF');
  same('python - <<EOF\nprint("a\\\\b")\nEOF');
  same('python - <<EOF\nprint(1)\\\nEOF');
  same("python - <<'EOF'\nx\n'@\nEOF");
  same("python - <<-'EOF'\n\tx\nEOF");
  same("python - <<'EOF'\nx\n");
  same('cat <<EOF > f.txt\nhi\nEOF');
  same("bash <<'EOF'\necho hi\nEOF");
  same("python - <<<'x'");
  same("echo x | python - <<'EOF'\nprint(1)\nEOF");
  same("python -c 'x' <<'EOF'\nprint(1)\nEOF");
  same("python - <<'EOF' > out.txt $x\nprint(1)\nEOF");
  // A skipped heredoc keeps its sibling bash-isms untouched too (the command fails anyway).
  same('cat <<EOF > f 2>/dev/null\nhi\nEOF');
  same('echo "python - <<\'EOF\'"');
});

test('only PowerShell-bound commands that contain a candidate are examined', () => {
  assert.equal(rewrite(''), null);
  assert.equal(rewrite(undefined), null);
  same('git status');
  same('Get-Content a.txt | Select-Object -Last 3');
});

// Integration: rewritten commands run in the real PowerShell.
const pwsh =
  process.platform === 'win32' ? spawnSync('pwsh', ['-NoProfile', '-Command', '1'], { encoding: 'utf8' }) : null;
const runPwsh = (script) =>
  spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 30000 });

test('a rewritten heredoc and /dev/null redirect run to the expected output', {
  skip: (!pwsh || pwsh.status !== 0) && 'requires pwsh on Windows',
}, () => {
  const script = rewrite("node - <<'EOF'\nconsole.log('hi ' + [1,2].length)\nEOF").command;
  assert.equal(runPwsh(script).stdout.trim(), 'hi 2');
  assert.equal(runPwsh(rewrite('node -e "console.log(7)" 2>/dev/null').command).stdout.trim(), '7');
  assert.equal(runPwsh(rewrite('node -e "console.log(8)" </dev/null').command).stdout.trim(), '8');
});

test('the shell tool runs the rewritten command and reports each rewrite', {
  skip: (!pwsh || pwsh.status !== 0) && 'requires pwsh on Windows',
}, async () => {
  const args = { command: 'node -e "console.log(41 + 1)" 2>/dev/null' };
  const prepared = prepareShellCommand(args);
  if (prepared.resolvedSpec?.shellType !== 'powershell') return;
  assert.equal(prepared.command, 'node -e "console.log(41 + 1)" 2>$null');
  assert.equal(prepared.analysisCommand, args.command);
  const out = await executeBashTool(args, process.cwd());
  const text = typeof out === 'string' ? out : out.result;
  assert.match(text, /^\[exit code: 0\]\n\[rewritten: "2>\/dev\/null" → "2>\$null"\]\n\n42/);
});

// Windows PowerShell 5.1: the shell prefix must leave $OutputEncoding BOM-less,
// or a piped here-string reaches `python -` / `node -` with a leading U+FEFF.
const ps51 =
  process.platform === 'win32'
    ? spawnSync('powershell.exe', ['-NoProfile', '-Command', '1'], { encoding: 'utf8' })
    : null;

const py = ps51 ? spawnSync('python', ['--version'], { encoding: 'utf8' }) : null;

// python rejects a leading U+FEFF ("invalid non-printable character"); node tolerates it.
test('under powershell.exe 5.1 a rewritten heredoc reaches python without a BOM', {
  skip: (!ps51 || ps51.status !== 0 || !py || py.status !== 0) && 'requires Windows PowerShell 5.1 and python',
}, () => {
  const heredoc = "python - <<'EOF'\nprint('ok', 1)\nEOF";
  const run = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', `${POWERSHELL_UTF8_PREFIX}\n${rewrite(heredoc).command}`],
    { encoding: 'utf8', timeout: 30000 }
  );
  assert.equal(run.stdout.trim(), 'ok 1', run.stderr);
});

test('the shell tool reports the stdin-safe prefix to display code unchanged', () => {
  assert.equal(displayShellCommand(`${POWERSHELL_UTF8_PREFIX}\nls`), 'ls');
});
