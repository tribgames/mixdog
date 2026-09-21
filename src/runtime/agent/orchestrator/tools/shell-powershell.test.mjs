import assert from 'node:assert/strict';
import test from 'node:test';
import { _maybeEncodePowerShellCommand, extractPowerShellCommandInner } from './shell-powershell.mjs';

test('PowerShell extraction and encoding preserve escaped quotes and automatic variables', () => {
  const cases = [
    {
      command: String.raw`pwsh -NoProfile -Command "Write-Output \"quoted\"; $_; $args"`,
      body: 'Write-Output "quoted"; $_; $args',
      prefix: 'pwsh -NoProfile',
    },
    {
      command: `powershell.exe -Command "Write-Output ""quoted"""`,
      body: 'Write-Output "quoted"',
      prefix: 'powershell.exe',
    },
    {
      command: `pwsh -NonInteractive -c 'Write-Output ''quoted'''`,
      body: "Write-Output 'quoted'",
      prefix: 'pwsh -NonInteractive',
    },
    {
      command: String.raw`pwsh -Command 'Write-Output \'quoted\''`,
      body: "Write-Output 'quoted'",
      prefix: 'pwsh',
    },
  ];
  for (const { command, body, prefix } of cases) {
    assert.deepEqual(extractPowerShellCommandInner(command), [body]);
    const expected =
      process.platform === 'win32'
        ? `${prefix} -EncodedCommand ${Buffer.from(body, 'utf16le').toString('base64')}`
        : command;
    assert.equal(_maybeEncodePowerShellCommand(command), expected);
  }
});

test('PowerShell extraction keeps multiple payloads and omits whitespace-only payloads', () => {
  const command = `pwsh -Command "Write-Output first"; pwsh -c 'Write-Output second'; pwsh -c ' '`;
  assert.deepEqual(extractPowerShellCommandInner(command), ['Write-Output first', 'Write-Output second']);
  assert.deepEqual(extractPowerShellCommandInner(command), ['Write-Output first', 'Write-Output second']);
});

test('PowerShell helpers preserve invalid and non-matching inputs', () => {
  for (const command of [null, undefined, false, 0, {}, '', 'echo fixture', 'pwsh -Command unquoted']) {
    assert.equal(_maybeEncodePowerShellCommand(command), command);
    assert.deepEqual(extractPowerShellCommandInner(command), []);
  }
});
