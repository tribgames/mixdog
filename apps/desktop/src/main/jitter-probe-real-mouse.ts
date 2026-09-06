/**
 * Real OS mouse for the selection probe (Windows only). CDP-synthesised
 * input never leaves the renderer, so window-exit behaviour — capture,
 * pointerleave timing, moves that stop arriving — can only be observed with
 * input that goes through the OS. One PowerShell child owns the P/Invoke
 * surface; the probe writes one command per line and waits for its `ok`.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { writeFileSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const DRIVER_SCRIPT = `
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class MxProbeMouse {
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
}
"@
$screenW = [int]$args[0]
$screenH = [int]$args[1]
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $p = $line.Split(' ')
  switch ($p[0]) {
    'move' {
      $nx = [uint32]([math]::Round(([double]$p[1] * 65535.0) / [double]($screenW - 1)))
      $ny = [uint32]([math]::Round(([double]$p[2] * 65535.0) / [double]($screenH - 1)))
      [MxProbeMouse]::mouse_event(0x8001, $nx, $ny, 0, [UIntPtr]::Zero)
    }
    'down' { [MxProbeMouse]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero) }
    'up' { [MxProbeMouse]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero) }
    'quit' { exit 0 }
  }
  [Console]::Out.WriteLine('ok')
  [Console]::Out.Flush()
}
`;

export class RealMouse {
  private child: ChildProcessWithoutNullStreams;
  private pending: Array<() => void> = [];
  private buffer = '';
  private pressed = false;

  constructor(screenWidth: number, screenHeight: number) {
    const dir = mkdtempSync(join(tmpdir(), 'mixdog-probe-mouse-'));
    const script = join(dir, 'mouse.ps1');
    writeFileSync(script, DRIVER_SCRIPT, 'utf8');
    this.child = spawn('powershell', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', script, String(screenWidth), String(screenHeight),
    ], { stdio: 'pipe', windowsHide: true });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk;
      let index = this.buffer.indexOf('\n');
      while (index >= 0) {
        this.buffer = this.buffer.slice(index + 1);
        this.pending.shift()?.();
        index = this.buffer.indexOf('\n');
      }
    });
  }

  private send(line: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.child.exitCode !== null) {
        reject(new Error('real mouse driver exited'));
        return;
      }
      this.pending.push(resolve);
      this.child.stdin.write(`${line}\n`);
    });
  }

  move(x: number, y: number): Promise<void> {
    return this.send(`move ${Math.round(x)} ${Math.round(y)}`);
  }

  async down(): Promise<void> {
    this.pressed = true;
    await this.send('down');
  }

  async up(): Promise<void> {
    this.pressed = false;
    await this.send('up');
  }

  /** Never leave the user's button held down, whatever the probe did. */
  async dispose(): Promise<void> {
    try {
      if (this.pressed) await this.up();
      // `quit` exits without an `ok`; never wait on it.
      this.child.stdin.write('quit\n');
    } catch {
      // Driver already gone.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    this.child.kill();
  }
}
