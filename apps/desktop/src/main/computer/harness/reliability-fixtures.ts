import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const WPF = String.raw`
Add-Type -AssemblyName PresentationFramework
$window = New-Object Windows.Window
$window.Title = 'Mixdog WPF Reliability Fixture'
$window.Width = 640; $window.Height = 420
$editor = New-Object Windows.Controls.TextBox
$editor.Text = 'fixture'
[Windows.Automation.AutomationProperties]::SetName($editor, 'Fixture editor')
$window.Content = $editor
$timer = New-Object Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds(250)
$deadline = [DateTime]::UtcNow.AddMinutes(3)
$timer.Add_Tick({
  [IO.File]::WriteAllText($env:MIXDOG_FIXTURE_STATE, $editor.Text)
  if ([DateTime]::UtcNow -gt $deadline -or [IO.File]::Exists($env:MIXDOG_FIXTURE_STOP)) { $window.Close() }
})
$window.Add_Closed({ $timer.Stop() })
$timer.Start()
$null = $window.ShowDialog()
`;

const EXCEL = String.raw`
$excel = $null; $book = $null
try {
  $excel = New-Object -ComObject Excel.Application
  $excel.DisplayAlerts = $false
  $excel.Visible = $true
  $book = $excel.Workbooks.Add()
  $excel.Caption = 'Mixdog Excel Reliability Fixture'
  $sheet = $book.Worksheets.Item(1)
  $cell = $sheet.Range('A1')
  $cell.Value2 = 'fixture'
  $null = $cell.Select()
  [IO.File]::WriteAllText($env:MIXDOG_FIXTURE_STATE + '.hwnd', ('hwnd:0x{0:x}' -f [long]$excel.Hwnd))
  $deadline = [DateTime]::UtcNow.AddMinutes(3)
  while ([DateTime]::UtcNow -lt $deadline -and -not [IO.File]::Exists($env:MIXDOG_FIXTURE_STOP)) {
    try { [IO.File]::WriteAllText($env:MIXDOG_FIXTURE_STATE, [string]$cell.Value2) } catch {}
    Start-Sleep -Milliseconds 250
  }
} finally {
  if ($book) { $book.Close($false) }
  if ($excel) { $excel.Quit() }
  foreach ($object in @($cell, $sheet, $book, $excel)) {
    if ($object) { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($object) }
  }
}
`;

export function startManagedFixture(kind: 'wpf' | 'excel', directory: string): {
  child: ChildProcess;
  state(): string;
  windowId(): string;
  stop(): void;
  errors(): string;
} {
  const state = join(directory, `${kind}-state.txt`);
  const stop = join(directory, `${kind}-stop`);
  const program = join(directory, `${kind}-fixture.ps1`);
  writeFileSync(program, `$ErrorActionPreference = 'Stop'\n${kind === 'wpf' ? WPF : EXCEL}`, 'utf8');
  let errors = '';
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', program], {
    windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, MIXDOG_FIXTURE_STATE: state, MIXDOG_FIXTURE_STOP: stop },
  });
  child.stderr?.on('data', (chunk) => { errors = (errors + String(chunk)).slice(-4096); });
  return {
    child,
    state: () => { try { return readFileSync(state, 'utf8'); } catch { return ''; } },
    windowId: () => { try { return readFileSync(`${state}.hwnd`, 'utf8'); } catch { return ''; } },
    stop: () => writeFileSync(stop, ''),
    errors: () => errors,
  };
}
