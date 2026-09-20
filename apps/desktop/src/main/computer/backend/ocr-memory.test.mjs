import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import test from 'node:test';
import { powershellHostProgram } from './program.ts';

test('OCR decodes generated pixels without creating screenshot files', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-ocr-memory-'));
  try {
    await writeFile(join(directory, 'host.ps1'), powershellHostProgram());
    const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$tokens = $null; $errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
  (Join-Path $env:OCR_FIXTURE 'host.ps1'), [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'host did not parse' }
foreach ($name in @('Await-WinRt','Do-OcrImage')) {
  $node = $ast.Find({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name}, $true)
  . ([scriptblock]::Create($node.Extent.Text))
}
$script:OriginalAwait = (Get-Command Await-WinRt).ScriptBlock
$script:Decoded = $null
function Await-WinRt($operation, [Type]$resultType) {
  $value = & $script:OriginalAwait $operation $resultType
  if ($resultType.FullName -eq 'Windows.Graphics.Imaging.SoftwareBitmap') {
    $script:Decoded = @($value.PixelWidth, $value.PixelHeight)
  }
  return $value
}
[Windows.Media.Ocr.OcrEngine, Windows.Media.Ocr, ContentType = WindowsRuntime] | Out-Null
[Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime] | Out-Null
$available = [Windows.Media.Ocr.OcrEngine]::IsLanguageSupported([Windows.Globalization.Language]::new('en-US'))
$bitmap = [Drawing.Bitmap]::new(240,80)
$graphics = [Drawing.Graphics]::FromImage($bitmap)
$graphics.Clear([Drawing.Color]::White)
$font = [Drawing.Font]::new('Arial',32)
$graphics.DrawString('TEST', $font, [Drawing.Brushes]::Black, 5, 5)
$memory = [IO.MemoryStream]::new()
try {
  $bitmap.Save($memory, [Drawing.Imaging.ImageFormat]::Png)
  $result = $null
  try {
    $result = Do-OcrImage @{image_base64=[Convert]::ToBase64String($memory.ToArray());ocr_language='en-US'}
  } catch {
    if ($available -or $_.Exception.Message -ne "Windows OCR has no recognizer for language 'en-US'") { throw }
  }
  @{available=$available;decoded=$script:Decoded;result=$result} | ConvertTo-Json -Compress -Depth 6
} finally {
  $memory.Dispose(); $font.Dispose(); $graphics.Dispose(); $bitmap.Dispose()
}
`;
    const { stdout } = await promisify(execFile)(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      {
        windowsHide: true,
        timeout: 20_000,
        env: { ...process.env, TEMP: directory, TMP: directory, OCR_FIXTURE: directory },
      }
    );
    const outcome = JSON.parse(stdout.trim());
    assert.deepEqual(outcome.decoded, [240, 80]);
    assert.equal(
      (await readdir(directory)).some((name) => name.startsWith('mixdog-ocr-')),
      false
    );
    await t.test('Windows OCR recognizes the generated text', (recognition) => {
      if (!outcome.available) {
        recognition.skip('Windows OCR en-US recognizer is not installed; recognition verification is blocked');
        return;
      }
      assert.ok(outcome.result.words.some((word) => word.text === 'TEST'));
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
