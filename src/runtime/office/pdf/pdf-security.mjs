import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { writeFile, rm, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';

// qpdf on PATH, or wherever MIXDOG_QPDF_PATH points (the Windows installer
// does not add itself to PATH).
const QPDF = process.env.MIXDOG_QPDF_PATH || 'qpdf';
const QPDF_PROBE_TIMEOUT_MS = 20_000;
const QPDF_RUN_TIMEOUT_MS = 120_000;

// Every run is bounded: a qpdf waiting on a prompt or a file it cannot finish
// would otherwise hold the session open with nothing to report.
function run(command, args, timeoutMs = QPDF_RUN_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    let stdout = '';
    let stderr = '';
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const finish = (operation) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      operation();
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', (error) => finish(() => reject(error)));
    child.once('close', (code) =>
      finish(() =>
        code === 0
          ? resolve({ stdout, stderr })
          : reject(new Error(stderr.trim() || stdout.trim() || `qpdf exited with code ${code}`))
      )
    );
    timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
      finish(() => reject(new Error(`qpdf timed out after ${timeoutMs / 1000} seconds`)));
    }, timeoutMs);
  });
}

let qpdfFound = false;

/** Whether qpdf answers on this machine. A program that answered stays found for
 *  the life of the process; a negative answer is probed again, because the user
 *  may install qpdf and retry without restarting. */
export async function qpdfAvailable() {
  if (qpdfFound) return true;
  try {
    await run(QPDF, ['--version'], QPDF_PROBE_TIMEOUT_MS);
    qpdfFound = true;
    return true;
  } catch {
    return false;
  }
}

export async function securePdf({ input, output, mode, password = '', ownerPassword = '' }) {
  if (!(await qpdfAvailable())) {
    throw new Error(
      'PDF encryption/decryption requires qpdf on PATH (or MIXDOG_QPDF_PATH) and it is not installed (Windows: winget install qpdf; macOS: brew install qpdf; Debian/Ubuntu: apt install qpdf); tell the user the file was left as is'
    );
  }
  const samePath = input.toLowerCase() === output.toLowerCase();
  const target = samePath ? join(dirname(output), `.mixdog-qpdf-${randomUUID()}.pdf`) : output;
  const responsePath = join(dirname(target), `.mixdog-qpdf-${randomUUID()}.args`);
  const quote = (value) => `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
  const args =
    mode === 'encrypt'
      ? ['--encrypt', password, ownerPassword || password, '256', '--', input, target]
      : [`--password=${password}`, '--decrypt', input, target];
  await writeFile(responsePath, `${args.map(quote).join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    await run(QPDF, [`@${responsePath}`]);
    if (samePath) await rename(target, output);
    return { ok: true, mode, input, output };
  } finally {
    await rm(responsePath, { force: true }).catch(() => {});
    if (samePath) await rm(target, { force: true }).catch(() => {});
  }
}
