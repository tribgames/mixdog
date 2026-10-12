import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import '../../../../../../../scripts/test-data-dir.mjs';
import { rewritePowerShellBashisms } from './bashism-rewrite.mjs';
import { prepareShellCommand } from './command-preflight.mjs';
import { executeBashTool } from '../bash-tool.mjs';

const rewrite = (command) => rewritePowerShellBashisms(command);
const same = (command) => assert.equal(rewrite(command), null, `must pass through untouched: ${JSON.stringify(command)}`);
const guard = (name, native, cmdlet) =>
  `| & { if (Get-Command ${name} -ErrorAction Ignore) { $input | ${native} } else { $input | ${cmdlet} } }`;

test('head/tail -N and -n N become guarded Select-Object, with the call text kept verbatim', () => {
  const head = rewrite('git log | head -20');
  assert.equal(head.command, `git log ${guard('head', 'head -20', 'Select-Object -First 20')}`);
  assert.equal(head.note, '[rewritten: "| head -20" → "| Select-Object -First 20"]');
  assert.equal(rewrite('x | tail -n 5').command, `x ${guard('tail', 'tail -n 5', 'Select-Object -Last 5')}`);
  assert.equal(rewrite('x |tail -n5').command, `x ${guard('tail', 'tail -n5', 'Select-Object -Last 5')}`);
  assert.equal(rewrite('x | head -n 3').command, `x ${guard('head', 'head -n 3', 'Select-Object -First 3')}`);
});

test('wc -l becomes a guarded line count', () => {
  const out = rewrite('git ls-files | wc -l');
  assert.equal(out.command, `git ls-files ${guard('wc', 'wc -l', 'Measure-Object | ForEach-Object Count')}`);
  assert.equal(out.note, '[rewritten: "| wc -l" → "| Measure-Object | ForEach-Object Count"]');
});

test('segments are rewritten in place: trailing redirects, separators, several pipes', () => {
  assert.equal(
    rewrite('a 2>&1 | tail -5 2>&1; echo done').command,
    `a 2>&1 ${guard('tail', 'tail -5', 'Select-Object -Last 5')} 2>&1; echo done`
  );
  const two = rewrite('a | head -2 | wc -l\nb | tail -1');
  assert.match(two.command, /Select-Object -First 2 \} \} \| & \{ if \(Get-Command wc/);
  assert.match(two.command, /\n b?|\nb \| & \{ if \(Get-Command tail/);
  assert.equal(two.note.split('\n').length, 3);
  assert.equal(rewrite('(a | head -1)').command, `(a ${guard('head', 'head -1', 'Select-Object -First 1')})`);
});

test('anything other than the exact form is left alone', () => {
  for (const cmd of [
    'x | head',
    'x | head -c 5',
    'x | head -n -5',
    'x | head -5 -v',
    'x | tail -f log',
    'x | tail -n +5',
    'x | tail -5 file.txt',
    'x | wc',
    'x | wc -c',
    'x | wc -l file.txt',
    'x || head -5',
    'x | head -5k',
    'head -5 file.txt',
    'x | Select-Object -First 5',
  ]) {
    same(cmd);
  }
});

test('quotes, here-strings, comments and escapes are never rewritten', () => {
  same("echo 'a | head -5'");
  same('echo "a | tail -3"');
  same("echo 'it''s | head -5'");
  same('echo "say `"hi`" | tail -2"');
  same("echo @'\nx | head -3\n'@");
  same('echo hi # | head -3');
  same('echo hi <# | head -3 #> there');
  same('echo `| head -5');
  same("echo '2>/dev/null' \"</dev/null\"");
  same('git log "unterminated | head -5');
  same('echo "a $(x | tail -1) b" | tail -2');
  // Live code next to quoted lookalikes: only the live one is rewritten.
  const mixed = rewrite('echo "it\'s | head -5" | tail -2');
  assert.equal(mixed.command, `echo "it's | head -5" ${guard('tail', 'tail -2', 'Select-Object -Last 2')}`);
  assert.equal(rewrite("echo 'say \"hi\" | tail -1' | head -1").note, '[rewritten: "| head -1" → "| Select-Object -First 1"]');
});

test('an already rewritten command is not rewritten again', () => {
  const once = rewrite('x | tail -4');
  assert.equal(rewrite(once.command), null);
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
  assert.equal(rewrite("cd src; node - <<'EOF'\nconsole.log(1)\nEOF\necho after").command,
    "cd src; @'\nconsole.log(1)\n'@ | node -\necho after");
  assert.equal(rewrite("a && py -u - <<'E'\nprint(1)\nE").command, "a && @'\nprint(1)\n'@ | py -u -");
  assert.equal(rewrite("python <<'EOF'\nprint(1)\nEOF").command, "@'\nprint(1)\n'@ | python");
  assert.equal(rewrite("python - <<'EOF' 2>&1\nprint(1)\nEOF").command, "@'\nprint(1)\n'@ | python - 2>&1");
  assert.equal(rewrite("python - <<'EOF'\r\nprint(1)\r\nEOF\r\n").command, "@'\nprint(1)\n'@ | python -\n");
  // An unquoted delimiter is rewritten only when bash would expand nothing.
  assert.equal(rewrite('python - <<EOF\nprint(1)\nEOF').command, "@'\nprint(1)\n'@ | python -");
  // A rewritten heredoc composes with the pipe rewrite on its opener line.
  assert.match(rewrite("node - <<'EOF' | tail -5\nconsole.log(1)\nEOF").command, /^@'\nconsole\.log\(1\)\n'@ \| node - \| & \{ if \(Get-Command tail/);
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
  same("cat <<EOF > f 2>/dev/null\nhi\nEOF");
  same("echo \"python - <<'EOF'\"");
});

test('only PowerShell-bound commands that contain a candidate are examined', () => {
  assert.equal(rewrite(''), null);
  assert.equal(rewrite(undefined), null);
  same('git status');
  same('Get-Content a.txt | Select-Object -Last 3');
});

// Integration: the guard runs inside the executing PowerShell session, so a
// head/tail/wc that resolves there is called exactly as written.
const pwsh = process.platform === 'win32' ? spawnSync('pwsh', ['-NoProfile', '-Command', '1'], { encoding: 'utf8' }) : null;
const runPwsh = (script) =>
  spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 30000 });

test(
  'a head/tail/wc that resolves in the session is used unchanged; otherwise the cmdlet runs',
  { skip: !pwsh || pwsh.status !== 0 },
  () => {
    const cases = [
      ['1..5 | head -n 2', 'function head { "STUB-HEAD:" + ($args -join " ") }', 'STUB-HEAD:-n 2', '1\n2'],
      ['1..5 | tail -3', 'function tail { "STUB-TAIL:" + ($args -join " ") }', 'STUB-TAIL:-3', '3\n4\n5'],
      ['1..5 | wc -l', 'Set-Alias wc Write-Output', null, '5'],
    ];
    for (const [command, stub, stubbed, plain] of cases) {
      const rewritten = rewrite(command).command;
      assert.equal(runPwsh(rewritten).stdout.trim().replace(/\r/g, ''), plain, `no head/tail/wc: ${command}`);
      if (stubbed) {
        assert.equal(runPwsh(`${stub}; ${rewritten}`).stdout.trim(), stubbed, `stub wins: ${command}`);
      }
    }
    // Blank lines count, as wc -l does.
    const count = runPwsh(rewrite('"a","","b" | wc -l').command);
    assert.equal(count.stdout.trim(), '3');
  }
);

test('a rewritten heredoc and /dev/null redirect run to the expected output', { skip: !pwsh || pwsh.status !== 0 }, () => {
  const script = rewrite("node - <<'EOF'\nconsole.log('hi ' + [1,2].length)\nEOF").command;
  assert.equal(runPwsh(script).stdout.trim(), 'hi 2');
  assert.equal(runPwsh(rewrite('node -e "console.log(7)" 2>/dev/null').command).stdout.trim(), '7');
  assert.equal(runPwsh(rewrite('node -e "console.log(8)" </dev/null').command).stdout.trim(), '8');
});

test('the shell tool runs the rewritten command and reports each rewrite', { skip: !pwsh || pwsh.status !== 0 }, async () => {
  const args = { command: 'node -e "console.log(41 + 1)" 2>/dev/null | tail -1' };
  const prepared = prepareShellCommand(args);
  if (prepared.resolvedSpec?.shellType !== 'powershell') return;
  assert.match(prepared.command, /2>\$null .*Get-Command tail/);
  assert.equal(prepared.analysisCommand, args.command);
  const out = await executeBashTool(args, process.cwd());
  const text = typeof out === 'string' ? out : out.result;
  assert.match(
    text,
    /^\[exit code: 0\]\n\[rewritten: "2>\/dev\/null" → "2>\$null"\]\n\[rewritten: "\| tail -1" → "\| Select-Object -Last 1"\]\n\n42/
  );
});
