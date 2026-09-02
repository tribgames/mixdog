import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const NATIVE_TEXT_FIXTURE_SOURCE = String.raw`
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
      Text = "Mixdog Computer Use native scenario."
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
    "$source = [IO.File]::ReadAllText($env:MIXDOG_NATIVE_FIXTURE_SOURCE, [Text.Encoding]::UTF8)",
    "Add-Type -TypeDefinition $source -Language CSharp -ReferencedAssemblies @('System.dll','System.Drawing.dll','System.Windows.Forms.dll') -OutputAssembly $env:MIXDOG_NATIVE_FIXTURE_OUTPUT -OutputType WindowsApplication",
  ].join('; ');
  execFileSync('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    compile,
  ], {
    windowsHide: true,
    stdio: 'pipe',
    env: {
      ...process.env,
      MIXDOG_NATIVE_FIXTURE_SOURCE: sourcePath,
      MIXDOG_NATIVE_FIXTURE_OUTPUT: outputPath,
    },
  });
  return outputPath;
}
