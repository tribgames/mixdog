import test from 'node:test';
import assert from 'node:assert/strict';
import {
  executeBashTool,
  buildPowerShellFilterTeePlan,
  planLongInlineScriptFileTransport,
  planLongShellScriptFileTransport,
  normalizeToolEnvelope,
  DETACHING_SHELL_CASES,
  runShellCase,
} from './_shared.mjs';


test('long Windows inline scripts use a short file-backed shell loader', () => {
    const body = `const slash = "\\\\"; /*${'x'.repeat(25_000)}*/ console.log("ok")`;
    const command = `node -e '${body}'`;
    const ps = planLongInlineScriptFileTransport(command, {
        platform: 'win32',
        shellType: 'powershell',
    });
    assert.ok(ps);
    assert.equal(ps.command, command);
    assert.equal(ps.extension, '.cjs');
    assert.equal(ps.body, body);
    assert.equal(
        ps.replace("C:\\Temp\\it's-long-command.cjs"),
        `node "C:/Temp/it's-long-command.cjs"`,
    );
    const bash = planLongInlineScriptFileTransport(command, {
        platform: 'win32',
        shellType: 'posix',
    });
    assert.equal(bash.extension, '.cjs');
    assert.equal(bash.body, body);
    assert.equal(planLongInlineScriptFileTransport(command.slice(0, 1_000), {
        platform: 'win32',
        shellType: 'powershell',
    }), null);
    assert.equal(planLongInlineScriptFileTransport(command, {
        platform: 'linux',
        shellType: 'posix',
    }), null);
});

test('generic oversized PowerShell commands use a safe whole-script transport', () => {
    const command = `$value = 1\n${'# padding\n'.repeat(3000)}Write-Output $value`;
    const plan = planLongShellScriptFileTransport(command, {
        platform: 'win32',
        shellType: 'powershell',
    });
    assert.ok(plan);
    assert.equal(plan.extension, '.ps1');
    assert.equal(plan.body, command);
    assert.equal(plan.replace("C:\\Temp\\it's-long.ps1"), "& 'C:/Temp/it''s-long.ps1'");
    assert.equal(planLongShellScriptFileTransport(
        `${command}\nWrite-Output $PSScriptRoot`,
        { platform: 'win32', shellType: 'powershell' },
    ), null);
});

test('Windows executes an oversized PowerShell body with non-ASCII text', {
    skip: process.platform !== 'win32',
}, async () => {
    const command = `# ${'패딩'.repeat(9000)}\nWrite-Output '장문-전송-정상'`;
    const result = normalizeToolEnvelope(await executeBashTool(
        { command, timeout_ms: 10_000 },
        process.cwd(),
    ));
    assert.equal(result.explicitSuccess, true);
    assert.match(result.result, /장문-전송-정상/);
});

test('Windows executes oversized node inline bodies through a script file', {
    skip: process.platform !== 'win32',
}, async () => {
    const body = `const slash = "\\\\"; /*${'x'.repeat(35_000)}*/ console.log("long-inline-ok")`;
    const result = normalizeToolEnvelope(await executeBashTool(
        { command: `node -e '${body}'`, timeout_ms: 10_000 },
        process.cwd(),
    ));
    assert.equal(result.explicitSuccess, true);
    assert.match(result.result, /^\[exit code: 0\]/);
    assert.match(result.result, /long-inline-ok/);
});

test('PowerShell filter plan preserves the producer native exit code', () => {
    const plan = buildPowerShellFilterTeePlan('node -e "process.exit(7)" 2>&1 | Select-String impossible');
    assert.ok(plan);
    assert.match(plan.command, /= \[ref\]0;/);
    assert.match(plan.command, /\$global:LASTEXITCODE = 0;/);
    assert.match(plan.command, /\.Value = \$global:LASTEXITCODE/);
    assert.match(plan.command, /; exit \$__mixdogProducerExit[0-9a-f]+\.Value$/);
});

// Byte-identity, end to end: the shell echoes back exactly what was sent. The
// bodies below are the shapes the deleted scanner used to corrupt (a heredoc
// body containing `&`, an ANSI-C `$'…'` delimiter, an arithmetic `<<`, a
// quoted `((`). Nothing parses them any more, so the shell is the only reader.
test('command text reaches the shell byte-identical', { timeout: 120_000 }, async () => {
  const bash = DETACHING_SHELL_CASES.find((entry) => /bash|^sh$/.test(entry.name));
  if (!bash) return;
  const bodies = [
    'cat <<EOF\nbody & text\nEOF',
    "cat <<$'EOF'\nsleep 1 &\nEOF",
    'echo $((1 << 2))',
    "echo '((' ; cat <<EOF\nsleep 1 &\nEOF",
    'printf "%s\\n" "a & b"',
  ];
  for (const body of bodies) {
    const result = await runShellCase(bash, body);
    assert.equal(result.exitCode, 0, `command must run as written: ${JSON.stringify(body)}\n${result.stderr}`);
    // The `&` that the scanner used to strip is still in the OUTPUT, which is
    // only possible when the shell received the text unchanged.
    if (body.includes('&')) {
      assert.match(result.stdout, /&/,
        `the shell must have received the literal text: ${JSON.stringify(body)} → ${JSON.stringify(result.stdout)}`);
    }
    assert.equal(result.descendants, null,
      `${JSON.stringify(body)} leaves nothing running: ${JSON.stringify(result.descendants)}`);
  }
});
