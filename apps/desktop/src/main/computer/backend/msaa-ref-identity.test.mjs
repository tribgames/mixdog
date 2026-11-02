import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { loadComputerSource } from './native-assets.ts';

const windows = { skip: process.platform !== 'win32' && 'Windows only', timeout: 30000 };

// Get-RefRecord against a mocked MSAA node: no window or accessibility tree needed.
const SCRIPT = `
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $env:FIXTURE_DIRECTORY 'input-refs.ps1'), [ref]$tokens, [ref]$errors)
foreach ($name in @('Get-MsaaIdentity', 'Get-RefRecord', 'Get-ElRuntimeKey')) {
  $node = $ast.Find({ param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name }, $true)
  . ([scriptblock]::Create($node.Extent.Text.Replace('function ', 'function global:')))
}
Add-Type -TypeDefinition 'using System; public static class MixWin32 { public static IntPtr ParseWindowId(string id) { return new IntPtr(1); } public static bool IsWindowHandle(IntPtr handle) { return true; } public static string WindowId(IntPtr handle) { return "w1"; } public static string NativeObservableState(IntPtr handle, string action) { return handle.ToInt64() == 7 ? "native_text=typed text" : ""; } }'
$script:CurrentRequest = @{}
$script:Session = @{ Generation = 1; Map = @{} }
function Get-CurrentSession { return $script:Session }
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
function New-Node($name, $type = 'Button') {
  $node = [pscustomobject]@{ ControlType = $type; Name = $name; Key = 'k'; WindowId = 'w1'; Enabled = $true; Offscreen = $false }
  $node | Add-Member -MemberType ScriptMethod -Name Refresh -Value { return $true }
  return $node
}
function New-Record($recorded, $current) {
  return @{ Kind = 'msaa'; Msaa = (New-Node $current); WindowId = 'w1'; Generation = 1; RuntimeId = 'k'; Identity = "Button|$recorded" }
}
function Get-TopWindow($el) { return [pscustomobject]@{ Current = [pscustomobject]@{ NativeWindowHandle = 1 } } }
function New-UiaRecord($recorded, $current, [int]$handle = 0) {
  $button = [pscustomobject]@{ Id = 50000 }
  $el = [pscustomobject]@{ Current = [pscustomobject]@{ ControlType = $button; Name = $current; NativeWindowHandle = $handle } }
  $el | Add-Member -MemberType ScriptMethod -Name GetRuntimeId -Value { return @(42, 7) }
  $identity = @{ ControlType = $button; Name = $recorded }
  return @{ Kind = 'uia'; Element = $el; WindowId = 'w1'; Generation = 1; RuntimeId = '42,7'; UiaIdentity = $identity }
}
$script:Session.Map['same'] = New-Record 'Save' 'Save'
$script:Session.Map['changed'] = New-Record 'Save' 'Delete'
$script:Session.Map['uiaSame'] = New-UiaRecord 'Save' 'Save'
$script:Session.Map['uiaChanged'] = New-UiaRecord 'Save' 'Delete'
# An edit's name mirrors its text, so typing renames it; a value-less button never may be.
$script:Session.Map['uiaEdit'] = New-UiaRecord 'old text' 'typed text' 7
$script:Session.Map['uiaRenamedWindow'] = New-UiaRecord 'Save' 'typed text' 8
$edit = New-Node 'typed text' 'Edit'
$edit | Add-Member -NotePropertyName Value -NotePropertyValue 'typed text'
$reused = New-Node 'Bank account' 'Edit'
$reused | Add-Member -NotePropertyName Value -NotePropertyValue ''
$script:Session.Map['msaaReused'] = @{ Kind = 'msaa'; Msaa = $reused; WindowId = 'w1'; Generation = 1; RuntimeId = 'k'; Identity = 'Edit|Search' }
$script:Session.Map['msaaEdit'] = @{ Kind = 'msaa'; Msaa = $edit; WindowId = 'w1'; Generation = 1; RuntimeId = 'k'; Identity = 'Edit|old text' }
$replacement = New-Node 'replacement' 'Edit'
$replacement | Add-Member -NotePropertyName Value -NotePropertyValue 'replacement'
$script:Session.Map['msaaReplacement'] = @{ Kind = 'msaa'; Msaa = $replacement; WindowId = 'w1'; Generation = 1; RuntimeId = 'k'; Identity = 'Edit|original' }
$script:Session.Map['msaaEditRole'] = @{ Kind = 'msaa'; Msaa = (New-Node 'old text' 'Button'); WindowId = 'w1'; Generation = 1; RuntimeId = 'k'; Identity = 'Edit|old text' }
$result = @{ same = $null; changed = $null; uiaSame = $null; uiaChanged = $null; uiaEdit = $null; uiaRenamedWindow = $null; msaaEdit = $null; msaaReused = $null; msaaEditRole = $null; msaaReplacement = $null }
$result.uiaEdit = (Get-RefRecord 'uiaEdit').Kind
try { Get-RefRecord 'msaaEdit' | Out-Null; $result.msaaEdit = 'accepted' } catch { $result.msaaEdit = [string]$_.Exception.Message }
try { Get-RefRecord 'msaaReplacement' | Out-Null; $result.msaaReplacement = 'accepted' } catch { $result.msaaReplacement = [string]$_.Exception.Message }
try { Get-RefRecord 'msaaReused' | Out-Null; $result.msaaReused = 'accepted' } catch { $result.msaaReused = [string]$_.Exception.Message }
try { Get-RefRecord 'uiaRenamedWindow' | Out-Null; $result.uiaRenamedWindow = 'accepted' } catch { $result.uiaRenamedWindow = [string]$_.Exception.Message }
try { Get-RefRecord 'msaaEditRole' | Out-Null; $result.msaaEditRole = 'accepted' } catch { $result.msaaEditRole = [string]$_.Exception.Message }
$result.same = (Get-RefRecord 'same').Kind
$result.uiaSame = (Get-RefRecord 'uiaSame').Kind
try { Get-RefRecord 'changed' | Out-Null; $result.changed = 'accepted' } catch { $result.changed = [string]$_.Exception.Message }
try { Get-RefRecord 'uiaChanged' | Out-Null; $result.uiaChanged = 'accepted' } catch { $result.uiaChanged = [string]$_.Exception.Message }
$result | ConvertTo-Json -Compress
`;

test('a plain ref action refuses an MSAA node whose role and name changed since the observation', windows, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-msaa-ref-'));
  try {
    await writeFile(join(directory, 'input-refs.ps1'), loadComputerSource('input-refs.ps1'));
    await writeFile(join(directory, 'test.ps1'), SCRIPT);
    const { stdout } = await promisify(execFile)(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-File', join(directory, 'test.ps1')],
      { timeout: 25000, windowsHide: true, env: { ...process.env, FIXTURE_DIRECTORY: directory } }
    );
    const result = JSON.parse(stdout.trim());
    assert.equal(result.same, 'msaa');
    assert.match(result.changed, /no longer identifies the same element/);
    assert.equal(result.uiaSame, 'uia');
    assert.match(result.uiaChanged, /no longer identifies the same element/);
    // A UIA field renamed by its own native text is still the element observed; a changed role is not.
    assert.equal(result.uiaEdit, 'uia');
    assert.match(result.uiaRenamedWindow, /no longer identifies the same element/);
    // MSAA has no runtime id, so a rename is refused even when the name equals the
    // value, and a replacement control in the same slot satisfies that equality too.
    assert.match(result.msaaEdit, /no longer identifies the same element/);
    assert.match(result.msaaReplacement, /no longer identifies the same element/);
    assert.match(result.msaaReused, /no longer identifies the same element/);
    assert.match(result.msaaEditRole, /no longer identifies the same element/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
