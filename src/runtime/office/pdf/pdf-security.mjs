import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFile, rm, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr.trim() || stdout.trim() || `qpdf exited with code ${code}`));
    });
  });
}

export async function qpdfAvailable() {
  try {
    await run('qpdf', ['--version']);
    return true;
  } catch {
    return false;
  }
}

export async function securePdf({
  input,
  output,
  mode,
  password = '',
  ownerPassword = '',
}) {
  if (!await qpdfAvailable()) {
    throw new Error('PDF encryption/decryption requires qpdf; it is not installed in this environment');
  }
  const samePath = input.toLowerCase() === output.toLowerCase();
  const target = samePath
    ? join(dirname(output), `.mixdog-qpdf-${randomUUID()}.pdf`)
    : output;
  const responsePath = join(dirname(target), `.mixdog-qpdf-${randomUUID()}.args`);
  const quote = (value) => `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
  const args = mode === 'encrypt'
    ? ['--encrypt', password, ownerPassword || password, '256', '--', input, target]
    : [`--password=${password}`, '--decrypt', input, target];
  await writeFile(responsePath, `${args.map(quote).join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    await run('qpdf', [`@${responsePath}`]);
    if (samePath) await rename(target, output);
    return { ok: true, mode, input, output };
  } finally {
    await rm(responsePath, { force: true }).catch(() => {});
    if (samePath) await rm(target, { force: true }).catch(() => {});
  }
}
