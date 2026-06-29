import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

const src = readFileSync('src/standalone/folder-dialog.mjs', 'utf8');
const fn = src.match(/function powershellScript[\s\S]*?return \[([\s\S]*?)\]\.join/);
if (!fn) throw new Error('parse failed');
// Re-eval powershellScript by importing - use dynamic compile
const modUrl = new URL('../src/standalone/folder-dialog.mjs', import.meta.url);
// Call pickFolder with a hook - instead duplicate minimal import
const { pickFolder } = await import(modUrl.href);

const child = spawn('powershell.exe', [
  '-NoLogo', '-NoProfile', '-STA', '-Command',
  [
    '$ErrorActionPreference = "Continue"',
    'try {',
    ...readFileSync('src/standalone/folder-dialog.mjs', 'utf8')
      .split('\n')
      .filter((l) => l.includes('Add-Type -AssemblyName') || l.includes('Add-Type -TypeDefinition') || l.includes('GetDialogOwnerCenter')),
    '} catch { Write-Error $_; exit 1 }',
  ].join('; '),
], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

let err = '';
child.stderr.on('data', (d) => { err += d.toString(); });
child.on('close', (code) => {
  console.log('code', code);
  console.log(err.slice(0, 2000));
});

