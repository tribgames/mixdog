import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { powershellHostProgram } from '../../backend/program.ts';

export async function runComputerProbe(probe) {
  let script = "[Console]::Error.WriteLine('probe:compile-host')\n" + powershellHostProgram();
  const requestLoop = 'while ($true) {\n  $line = $__stdin.ReadLine()';
  if (!script.includes(requestLoop)) throw new Error('native request-loop insertion point is missing');
  script = script.replace(requestLoop, () => `${probe}\n${requestLoop}`);
  const directory = await mkdtemp(join(tmpdir(), 'mixdog-computer-safety-'));
  const path = join(directory, 'probe.ps1');
  try {
    // Windows PowerShell needs a BOM for literal non-ASCII fixture text.
    await writeFile(path, '\uFEFF' + script);
    const { stdout } = await promisify(execFile)('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path,
    ], { encoding: 'utf8', timeout: 180_000, windowsHide: true });
    const line = stdout.split(/\r?\n/).find((value) => value.startsWith('@@MIXCU@@'));
    if (!line) throw new Error('native safety probe returned no result');
    return JSON.parse(line.slice('@@MIXCU@@'.length));
  } catch (error) {
    throw new Error(
      `native safety probe failed: ${error.message}\nlast stages:\n${String(error.stderr || '').slice(-8_000)}`
        + `\noutput:\n${String(error.stdout || '').slice(-8_000)}`, { cause: error },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
