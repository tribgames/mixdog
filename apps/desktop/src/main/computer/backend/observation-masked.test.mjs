import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { loadComputerSource } from './native-assets.ts';

const windows = { skip: process.platform !== 'win32' && 'Windows only', timeout: 30000 };

// Test-RecordMasked against mocked records: no window or accessibility tree needed.
const SCRIPT = `
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $env:FIXTURE_DIRECTORY 'observation.ps1'), [ref]$tokens, [ref]$errors)
$node = $ast.Find({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Test-RecordMasked' }, $true)
. ([scriptblock]::Create($node.Extent.Text.Replace('function ', 'function global:')))
function New-Msaa([string]$state) {
  $msaa = [pscustomobject]@{}
  $msaa | Add-Member -MemberType ScriptMethod -Name IsProtected -Value $(
    if ($state -eq 'unreadable') { { throw 'state unreadable' } }
    elseif ($state -eq 'protected') { { return $true } }
    else { { return $false } })
  return @{ Kind = 'msaa'; Msaa = $msaa }
}
function New-Uia([bool]$password) {
  return @{ Kind = 'uia'; Element = [pscustomobject]@{ Current = [pscustomobject]@{ IsPassword = $password; NativeWindowHandle = 0 } } }
}
@{
  msaaPlainBox = (Test-RecordMasked (New-Msaa 'plain'))
  msaaProtected = (Test-RecordMasked (New-Msaa 'protected'))
  msaaUnreadable = (Test-RecordMasked (New-Msaa 'unreadable'))
  uiaPassword = (Test-RecordMasked (New-Uia $true))
  uiaPlain = (Test-RecordMasked (New-Uia $false))
} | ConvertTo-Json -Compress
`;

test('an element is classified as a password by its own state, MSAA records included', windows, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-masked-'));
  try {
    await writeFile(join(directory, 'observation.ps1'), loadComputerSource('observation.ps1'));
    await writeFile(join(directory, 'test.ps1'), SCRIPT);
    const { stdout } = await promisify(execFile)(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-File', join(directory, 'test.ps1')],
      { timeout: 25000, windowsHide: true, env: { ...process.env, FIXTURE_DIRECTORY: directory } }
    );
    assert.deepEqual(JSON.parse(stdout.trim()), {
      msaaPlainBox: false,
      msaaProtected: true,
      msaaUnreadable: true,
      uiaPassword: true,
      uiaPlain: false,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('the MSAA node answers whether its own state is protected, unreadable counting as protected', () => {
  const source = loadComputerSource('MixMsaa.cs');
  assert.match(source, /public bool IsProtected\(\)[\s\S]*0x20000000u[\s\S]*catch \{ return true; \}/);
});
