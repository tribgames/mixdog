# Records what Windows PowerShell 5.1 shows for deliberately failing COM calls, so the Rust layer's error texts and
# HRESULTs (src/com/errtext.rs) are held to the real ones.
#
# Run it by hand on the migration PC, in Windows PowerShell 5.1 (not PowerShell 7), with Microsoft Word, Excel and
# PowerPoint installed and no Office window open that holds unsaved work. It starts its own hidden Office instances,
# kills the Excel it started for the disconnect cases, and writes
#   tests/fixtures/errors/corpus.json     one entry per failing call (see Write-Corpus for the fields)
#   tests/fixtures/errors/MANIFEST.json   the PowerShell version, the Office builds and the sha256 of the corpus
# next to the crate root (the folder above recorder/). It sends no keyboard or mouse input except the one SendKeys of
# the busy-Excel case, which is skipped (reproduced = false) when Excel does not answer busy.
#
#   powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File recorder\errors-corpus.ps1

Set-StrictMode -Off
$ErrorActionPreference = 'Stop'

if ($PSVersionTable.PSVersion.Major -ne 5) { throw 'Run this in Windows PowerShell 5.1.' }

$crate = Split-Path -Parent $PSScriptRoot
$outDir = Join-Path $crate 'tests\fixtures\errors'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$entries = New-Object System.Collections.ArrayList
$suffixPattern = '\(Exception from HRESULT: 0x[0-9A-Fa-f]{8}( \([A-Za-z0-9_]+\))?\)$'

function Get-Chain($exception) {
    $chain = @()
    $e = $exception
    while ($null -ne $e) {
        $chain += [ordered]@{ type = $e.GetType().FullName; hresult = [int]$e.HResult; message = [string]$e.Message }
        $e = $e.InnerException
    }
    return , $chain
}

# Runs $operation, which must fail, and records the exception chain. $kind is call, get or set; $argc the number of
# arguments PowerShell passed. A call that does not fail is recorded with reproduced = false.
function Add-Failure([string]$id, [string]$kind, [string]$member, [int]$argc, [scriptblock]$operation) {
    $entry = [ordered]@{ id = $id; kind = $kind; member = $member; argc = $argc; reproduced = $false }
    try {
        $null = & $operation
        $entry.result = 'no failure'
    }
    catch {
        $exception = $_.Exception
        $chain = Get-Chain $exception
        $inner = $chain[$chain.Count - 1]
        $entry.reproduced = $true
        $entry.outerType = $chain[0].type
        $entry.hresult = $chain[0].hresult
        $entry.message = $chain[0].message
        $entry.innerType = $inner.type
        $entry.innerHResult = $inner.hresult
        $entry.innerMessage = $inner.message
        $entry.chain = $chain
        # The text the system gave (FormatMessage) is what is left of the inner message once .NET's suffix is cut;
        # a message that has no such suffix is a description the application gave (EXCEPINFO) or a mapped exception's own.
        if ($inner.message -match $suffixPattern) {
            $system = ($inner.message -replace (' ?' + $suffixPattern), '').Trim()
            $entry.description = $null
            $entry.systemText = $(if ($system) { $system } else { $null })
        }
        else {
            $entry.description = $inner.message
            $entry.systemText = $null
        }
    }
    [void]$entries.Add($entry)
}

# A call that must succeed and answer $null: the binder's answer for a member that does not exist.
function Add-Result([string]$id, [string]$kind, [string]$member, [int]$argc, [scriptblock]$operation) {
    $entry = [ordered]@{ id = $id; kind = $kind; member = $member; argc = $argc; reproduced = $true }
    try {
        $value = & $operation
        $entry.result = $(if ($null -eq $value) { 'null' } else { [string]$value })
    }
    catch {
        $entry.reproduced = $false
        $entry.result = 'failed: ' + $_.Exception.Message
    }
    [void]$entries.Add($entry)
}

function New-Office([string]$progId) {
    $app = New-Object -ComObject $progId
    try { $app.Visible = $false } catch {}
    try { $app.DisplayAlerts = 0 } catch {}
    return $app
}

$missingFile = Join-Path $env:TEMP 'mixdog-errors-corpus-no-such-file.xlsx'
$builds = [ordered]@{}

# Excel.
$excel = New-Office 'Excel.Application'
$builds.excel = [string]$excel.Version + '.' + [string]$excel.Build
$workbook = $excel.Workbooks.Add()
$sheet = $workbook.Worksheets.Item(1)
Add-Failure 'excel-open-missing-file' 'call' 'Open' 1 { $excel.Workbooks.Open($missingFile) }
Add-Failure 'excel-range-item-zero' 'call' 'Item' 1 { $sheet.Range('A1').Item(0) }
Add-Failure 'excel-worksheet-name-set' 'set' 'Name' 0 { $sheet.Name = 'a:b' }
Add-Failure 'excel-parameterized-set' 'set' 'Item' 1 { $sheet.Range('A1').Item(0) = 1 }
Add-Failure 'excel-missing-method' 'call' 'NoSuchMethod' 0 { $excel.NoSuchMethod() }
Add-Result 'excel-missing-property' 'get' 'NoSuchProperty' 0 { $excel.NoSuchProperty }
Add-Failure 'excel-missing-property-set' 'set' 'NoSuchProperty' 0 { $excel.NoSuchProperty = 1 }

# Busy Excel: put a cell in edit mode (F2) and call into it. Skipped when Excel does not answer busy.
try {
    $excel.Visible = $true
    $null = $sheet.Range('A1').Select()
    $excel.SendKeys('{F2}')
    Start-Sleep -Milliseconds 300
    Add-Failure 'excel-busy-in-edit-mode' 'set' 'Value2' 0 { $sheet.Range('B1').Value2 = 1 }
}
finally {
    try { $excel.SendKeys('{ESC}') } catch {}
    try { $excel.Visible = $false } catch {}
}

# Null receivers (nothing COM about them; recorded for the binder rules of obj.rs).
Add-Failure 'null-method-call' 'call' 'Foo' 0 { $null.Foo() }
Add-Failure 'null-property-set' 'set' 'Foo' 0 { $null.Foo = 1 }
Add-Result 'null-property-get' 'get' 'Foo' 0 { $null.Foo }

# The application killed under the proxy: RPC_E_DISCONNECTED or 0x800706BA, whichever the first and second call give.
$excelProcessId = 0
try { $excelProcessId = (Get-Process excel | Sort-Object StartTime | Select-Object -Last 1).Id } catch {}
if ($excelProcessId) {
    Stop-Process -Id $excelProcessId -Force
    Start-Sleep -Milliseconds 500
    Add-Failure 'excel-killed-first-get' 'get' 'Name' 0 { $excel.Name }
    Add-Failure 'excel-killed-second-get' 'get' 'Name' 0 { $excel.Name }
    Add-Failure 'excel-killed-call' 'call' 'Quit' 0 { $excel.Quit() }
}

# Word.
$word = New-Office 'Word.Application'
$builds.word = [string]$word.Version + '.' + [string]$word.Build
Add-Failure 'word-no-active-document-get' 'get' 'ActiveDocument' 0 { $word.ActiveDocument.Name }
$document = $word.Documents.Add()
Add-Failure 'word-parameterized-get' 'get' 'Compatibility' 1 { $document.Compatibility(9999) }
Add-Failure 'word-parameterized-set' 'set' 'Compatibility' 1 { $document.Compatibility(9999) = $true }
Add-Failure 'word-paragraph-item-zero' 'call' 'Item' 1 { $document.Paragraphs.Item(0) }
Add-Failure 'word-open-missing-file' 'call' 'Open' 1 { $word.Documents.Open($missingFile) }
try { $document.Close(0) } catch {}
try { $word.Quit(0) } catch {}

# PowerPoint.
$powerpoint = New-Object -ComObject 'PowerPoint.Application'
$builds.powerpoint = [string]$powerpoint.Version + '.' + [string]$powerpoint.Build
Add-Failure 'powerpoint-open-missing-file' 'call' 'Open' 4 { $powerpoint.Presentations.Open($missingFile, $true, $true, $false) }
Add-Failure 'powerpoint-slide-item-zero' 'call' 'Item' 1 {
    $presentation = $powerpoint.Presentations.Add($false)
    try { $presentation.Slides.Item(0) } finally { try { $presentation.Close() } catch {} }
}
try { $powerpoint.Quit() } catch {}

$corpus = [ordered]@{
    recorded = $true
    source = 'recorder/errors-corpus.ps1 in Windows PowerShell ' + $PSVersionTable.PSVersion.ToString()
    entries = $entries
}
$json = ($corpus | ConvertTo-Json -Depth 8) -replace "`r`n", "`n"
$utf8 = New-Object System.Text.UTF8Encoding($false)
$corpusPath = Join-Path $outDir 'corpus.json'
[System.IO.File]::WriteAllText($corpusPath, $json + "`n", $utf8)

$sha = [System.BitConverter]::ToString(
    [System.Security.Cryptography.SHA256]::Create().ComputeHash($utf8.GetBytes($json + "`n"))
).Replace('-', '').ToLowerInvariant()
$manifest = [ordered]@{
    recorded = $true
    powershell = $PSVersionTable.PSVersion.ToString()
    office = $builds
    corpus = 'corpus.json'
    corpusSha256 = $sha
}
[System.IO.File]::WriteAllText((Join-Path $outDir 'MANIFEST.json'), (($manifest | ConvertTo-Json -Depth 4) -replace "`r`n", "`n") + "`n", $utf8)
Write-Host "Wrote $($entries.Count) entries to $corpusPath"
