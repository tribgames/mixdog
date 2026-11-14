import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const NATIVE_TEXT_FIXTURE_SOURCE = `
using System;
using System.Drawing;
using System.Windows.Forms;

internal static class MixdogNativeTextFixture {
  [STAThread]
  private static void Main() {
    Application.EnableVisualStyles();
    Application.SetCompatibleTextRenderingDefault(false);
    Form form = new Form {
      Text = "Mixdog Native Text Fixture",
      Width = 640,
      Height = 420,
      StartPosition = FormStartPosition.CenterScreen
    };
    TextBox editor = new TextBox {
      AccessibleName = "Native text editor",
      Dock = DockStyle.Fill,
      Multiline = true,
      AcceptsReturn = true,
      Text = "Mixdog Computer Use native scenario."
    };
    TextBox second = new TextBox {
      AccessibleName = "Native second field",
      Dock = DockStyle.Top
    };
    Label status = new Label {
      AccessibleName = "Menu status",
      Dock = DockStyle.Bottom,
      Height = 32,
      Text = "READY",
      TextAlign = ContentAlignment.MiddleLeft
    };
    MenuStrip menu = new MenuStrip();
    ToolStripMenuItem fixtureMenu = new ToolStripMenuItem("Fixture");
    ToolStripMenuItem activate = new ToolStripMenuItem("Activate");
    activate.Click += delegate {
      status.Text = "MENU ACTIVATED";
      form.Text = "Mixdog Native Menu Activated";
    };
    fixtureMenu.DropDownItems.Add(activate);
    menu.Items.Add(fixtureMenu);
    form.MainMenuStrip = menu;
    form.Controls.Add(editor);
    form.Controls.Add(second);
    form.Controls.Add(status);
    form.Controls.Add(menu);
    System.Windows.Forms.Timer lifetime = new System.Windows.Forms.Timer {
      Interval = 30000
    };
    lifetime.Tick += delegate {
      lifetime.Stop();
      form.Close();
    };
    form.FormClosed += delegate { lifetime.Dispose(); };
    lifetime.Start();
    Application.Run(form);
  }
}
`;


export function compileNativeTextFixture(directory: string): string {
  const sourcePath = join(directory, 'mixdog-native-text-fixture.cs');
  const outputPath = join(directory, 'mixdog-native-text-fixture.exe');
  writeFileSync(sourcePath, NATIVE_TEXT_FIXTURE_SOURCE, 'utf8');
  const compile = [
    "$ErrorActionPreference = 'Stop'",
    '$source = [IO.File]::ReadAllText($env:MIXDOG_NATIVE_FIXTURE_SOURCE, [Text.Encoding]::UTF8)',
    "Add-Type -TypeDefinition $source -Language CSharp -ReferencedAssemblies @('System.dll','System.Drawing.dll','System.Windows.Forms.dll') -OutputAssembly $env:MIXDOG_NATIVE_FIXTURE_OUTPUT -OutputType WindowsApplication",
  ].join('; ');
  execFileSync(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', compile],
    {
      windowsHide: true,
      stdio: 'pipe',
      env: {
        ...process.env,
        MIXDOG_NATIVE_FIXTURE_SOURCE: sourcePath,
        MIXDOG_NATIVE_FIXTURE_OUTPUT: outputPath,
      },
    }
  );
  return outputPath;
}

const WPF = `
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

// A focusable text surface with no value: its content is reachable only through
// TextPattern, the way a terminal buffer or a rich document body is.
const WPF_DOCUMENT = `
Add-Type -AssemblyName PresentationFramework
$window = New-Object Windows.Window
$window.Title = 'Mixdog WPF Document Fixture'
$window.Width = 640; $window.Height = 420
$document = New-Object Windows.Controls.RichTextBox
$document.IsReadOnly = $true
$document.Document.Blocks.Clear()
foreach ($line in @('DOCUMENT_LINE_ONE', 'DOCUMENT_LINE_TWO')) {
  $document.Document.Blocks.Add((New-Object Windows.Documents.Paragraph (New-Object Windows.Documents.Run $line)))
}
[Windows.Automation.AutomationProperties]::SetName($document, 'Fixture document')
$window.Content = $document
$timer = New-Object Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds(250)
$deadline = [DateTime]::UtcNow.AddMinutes(3)
$timer.Add_Tick({
  if ([DateTime]::UtcNow -gt $deadline -or [IO.File]::Exists($env:MIXDOG_FIXTURE_STOP)) { $window.Close() }
})
$window.Add_Closed({ $timer.Stop() })
$timer.Start()
$null = $window.ShowDialog()
`;

const EXCEL = `
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

export function startManagedFixture(
  kind: 'wpf' | 'wpf-document' | 'excel',
  directory: string
): {
  child: ChildProcess;
  state(): string;
  windowId(): string;
  stop(): void;
  errors(): string;
} {
  const state = join(directory, `${kind}-state.txt`);
  const stop = join(directory, `${kind}-stop`);
  const program = join(directory, `${kind}-fixture.ps1`);
  const source = { wpf: WPF, 'wpf-document': WPF_DOCUMENT, excel: EXCEL }[kind];
  writeFileSync(program, `$ErrorActionPreference = 'Stop'\n${source}`, 'utf8');
  let errors = '';
  const child = spawn(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', program],
    {
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, MIXDOG_FIXTURE_STATE: state, MIXDOG_FIXTURE_STOP: stop },
    }
  );
  child.stderr?.on('data', (chunk) => {
    errors = (errors + String(chunk)).slice(-4096);
  });
  return {
    child,
    state: () => {
      try {
        return readFileSync(state, 'utf8');
      } catch {
        return '';
      }
    },
    windowId: () => {
      try {
        return readFileSync(`${state}.hwnd`, 'utf8');
      } catch {
        return '';
      }
    },
    stop: () => writeFileSync(stop, ''),
    errors: () => errors,
  };
}
