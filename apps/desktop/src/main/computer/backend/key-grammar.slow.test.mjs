import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import test from 'node:test';
import { BLOCKED_COMPUTER_KEY_PATTERN_SOURCE } from '../input/guards.ts';

test('shared dangerous key grammar has JavaScript and PowerShell regex parity', { skip: process.platform !== 'win32' }, async () => {
  const cases = [
    { keys: '^%{DELETE}', blocked: true }, { keys: '%^{END 2}', blocked: true },
    { keys: '{TAB}+{DELETE 100}', blocked: true }, { keys: '^%+{F4}', blocked: true },
    { keys: '^{DELETE}', blocked: false }, { keys: '%{END}', blocked: false },
    { keys: '+{F4}', blocked: false }, { keys: '{TAB}{DELETE}', blocked: false },
  ];
  const patternBase64 = Buffer.from(BLOCKED_COMPUTER_KEY_PATTERN_SOURCE, 'utf8').toString('base64');
  const casesBase64 = Buffer.from(JSON.stringify(cases), 'utf8').toString('base64');
  const script = `
$pattern = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${patternBase64}'))
$cases = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${casesBase64}')) | ConvertFrom-Json
$results = @($cases | ForEach-Object { [bool](([string]$_.keys) -match ('(?i)' + $pattern)) })
[Console]::Out.Write(($results | ConvertTo-Json -Compress))
`;
  const { stdout } = await promisify(execFile)('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
  ], { windowsHide: true, timeout: 5_000, maxBuffer: 1024 * 1024 });
  assert.deepEqual(JSON.parse(stdout), cases.map((entry) => entry.blocked));
});
