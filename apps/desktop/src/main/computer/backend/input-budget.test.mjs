import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import { assertSafeComputerInput } from '../input/guards.ts';
import { powershellHostProgram } from './program.ts';
import { validateComputerToolArgs } from '../../../../../../src/runtime/computer-bridge/action-schema.mjs';
import { MAX_COMPUTER_FOREGROUND_TEXT_CHARS as maximum } from '../../../../../../src/runtime/computer-bridge/limits.mjs';

test('foreground typing budgets are checked before dispatch without reducing background values', () => {
  for (const [delivery, length, accepted] of [
    ['foreground', maximum, true], ['foreground', maximum + 1, false], ['background', 30_000, true],
  ]) {
    const text = 'x'.repeat(length);
    const error = validateComputerToolArgs({ action: 'act', input: {
      window_id: 'hwnd:0x1', delivery, actions: [{ type: 'type', text }],
    } });
    const nativeCommand = { action: 'type', delivery, window_id: 'hwnd:0x1', text };
    if (accepted) {
      assert.equal(error, null);
      assert.doesNotThrow(() => assertSafeComputerInput(nativeCommand));
    } else {
      assert.match(error, /foreground text exceeds/);
      assert.throws(() => assertSafeComputerInput(nativeCommand), /foreground text exceeds/);
    }
  }
});

test('the native typing guard refuses excess text before resolving any window', {
  skip: process.platform !== 'win32', timeout: 10_000,
}, async () => {
  const script = String.raw`
$ErrorActionPreference='Stop'
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
$source=[Console]::In.ReadToEnd()
$tokens=$null; $errors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseInput($source,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'host program did not parse'}
$limit=$ast.Find({
 param($n)
 $n -is [System.Management.Automation.Language.AssignmentStatementAst] -and
 $n.Left -is [System.Management.Automation.Language.VariableExpressionAst] -and
 $n.Left.VariablePath.UserPath -eq 'script:MaximumForegroundTextCharacters'
},$true)
. ([scriptblock]::Create($limit.Extent.Text))
$type=$ast.Find({
 param($n)
 $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Do-Type'
},$true)
. ([scriptblock]::Create($type.Extent.Text))
$script:targetResolved=$false
function Resolve-WindowInfo { $script:targetResolved=$true; throw 'unexpected target lookup' }
$message=''
try { Do-Type @{delivery='foreground';window_id='hwnd:0x1';text=('x'*($script:MaximumForegroundTextCharacters+1))} }
catch { $message=$_.Exception.Message }
@{message=$message;targetResolved=$script:targetResolved} | ConvertTo-Json -Compress
`;
  const execution = promisify(execFile)('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
  ], { windowsHide: true, timeout: 8_000 });
  execution.child.stdin.end(powershellHostProgram());
  const { stdout } = await execution;
  const result = JSON.parse(stdout.trim());
  assert.equal(result.targetResolved, false);
  assert.match(result.message, /input_too_large: foreground text exceeds/);
});
