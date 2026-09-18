import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import { powershellHostProgram } from './program.ts';

test('Windows OCR accepts a lossless source larger than its engine limit and returns the recognized coordinate size', {
  skip: process.platform !== 'win32',
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-ocr-resolution-'));
  try {
    await writeFile(join(directory, 'host.ps1'), powershellHostProgram());
    const script = String.raw`
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
[Windows.Media.Ocr.OcrEngine, Windows.Media.Ocr, ContentType = WindowsRuntime] | Out-Null
$limit = [int][Windows.Media.Ocr.OcrEngine]::MaxImageDimension
$width = $limit + 200
$bitmap = [Drawing.Bitmap]::new($width,500)
$graphics = [Drawing.Graphics]::FromImage($bitmap)
$graphics.Clear([Drawing.Color]::White)
$font = [Drawing.Font]::new('Arial',48)
$graphics.DrawString('MIXDOG TEST', $font, [Drawing.Brushes]::Black, 50, 50)
$memory = [IO.MemoryStream]::new()
try {
  $bitmap.Save($memory, [Drawing.Imaging.ImageFormat]::Png)
  $result = Do-OcrImage @{image_base64=[Convert]::ToBase64String($memory.ToArray())}
  @{
    limit=$limit
    source_width=$width
    image_width=$result.image_width
    image_height=$result.image_height
    words=@($result.words | ForEach-Object { $_.text })
  } | ConvertTo-Json -Compress
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
        env: { ...process.env, OCR_FIXTURE: directory },
      }
    );
    const result = JSON.parse(stdout.trim());
    assert.equal(result.image_width, result.limit);
    assert.equal(result.image_height, Math.floor((500 * result.limit) / result.source_width));
    assert.ok(result.words.includes('TEST'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
