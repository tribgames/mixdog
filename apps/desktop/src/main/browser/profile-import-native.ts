import { spawn } from 'node:child_process';
import { createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { base64Bytes } from './profile-import-key';

export interface NativeBrowserImporter {
  executable: string;
  sha256: string;
}

/** The importer's fixed stderr messages the desktop reacts to
 *  (native/mixdog-browser-import/src/failure.rs). */
export const NATIVE_FAILURE = {
  chromeRunning: 'Chrome is still running. Close Chrome and try again.',
  savedKeyRejected: 'The saved Chrome key was rejected.',
  savedKeyRequired: 'A saved Chrome key is required.',
} as const;

interface NativeBrowserImporterEnvironment {
  isPackaged: boolean;
  platform: NodeJS.Platform;
  resourcesPath: string;
}

export function nativeBrowserImporterPath(environment: NativeBrowserImporterEnvironment & { cwd: string }): string {
  const fileName = environment.platform === 'win32' ? 'mixdog-browser-import.exe' : 'mixdog-browser-import';
  if (environment.isPackaged) {
    return join(environment.resourcesPath, 'native-tools', fileName);
  }
  return join(environment.cwd, 'native', 'mixdog-browser-import', 'target', 'release', fileName);
}

export async function resolvePackagedBrowserImporter(
  environment: NativeBrowserImporterEnvironment & { requestedPath?: string }
): Promise<NativeBrowserImporter | undefined> {
  if (!environment.isPackaged || environment.platform !== 'win32') return undefined;
  if (!environment.requestedPath) return undefined;
  const expected = resolve(environment.resourcesPath, 'native-tools', 'mixdog-browser-import.exe');
  if (resolve(environment.requestedPath).toLowerCase() !== expected.toLowerCase()) {
    return undefined;
  }
  if (!existsSync(expected)) return undefined;
  if (!existsSync(join(dirname(expected), 'bitwarden_chromium_import_helper.exe'))) {
    return undefined;
  }
  return {
    executable: expected,
    sha256: createHash('sha256')
      .update(await readFile(expected))
      .digest('hex'),
  };
}

const NATIVE_OUTPUT_LIMIT = 64 * 1024 * 1024;
const NATIVE_IMPORT_TIMEOUT_MS = 120_000;

async function sha256File(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

/** Runs the child with `input` on stdin. Settles on the child's `close` (the
 *  process has exited and its stdio is drained), never on `exit`, which can
 *  fire while stdout still holds unread data. A spawn that throws synchronously
 *  rejects this promise like any other failure. */
async function runNativeChild(
  executable: string,
  args: string[],
  input: Buffer
): Promise<{ exitCode: number; stdout: Buffer; stderr: Buffer; stdoutBytes: number }> {
  const child = spawn(executable, args, {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const closed = new Promise<number>((resolveClose, rejectClose) => {
    const timer = setTimeout(() => {
      child.kill();
      rejectClose(new Error('Native browser importer timed out.'));
    }, NATIVE_IMPORT_TIMEOUT_MS);
    child.once('error', (error) => {
      clearTimeout(timer);
      rejectClose(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolveClose(code ?? 1);
    });
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  child.stdout?.on('data', (chunk: Buffer) => {
    stdoutBytes += chunk.length;
    if (stdoutBytes > NATIVE_OUTPUT_LIMIT) {
      child.kill();
      return;
    }
    stdout.push(chunk);
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrBytes += chunk.length;
    if (stderrBytes <= 16_384) stderr.push(chunk);
  });
  child.stdin?.end(input);
  const exitCode = await closed;
  return { exitCode, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), stdoutBytes };
}

/** `createTransportKey` is a test seam: the default is the production key.
 *  `savedKey` (the Chrome v20 key, with `--v20-key-stdin`) follows the
 *  transport key on a second stdin line: never in arguments or the environment. */
export async function readEncryptedChildJson(
  executable: string,
  args: string[],
  expectedSha256: string,
  createTransportKey: () => Buffer = () => randomBytes(32),
  savedKey?: Buffer
): Promise<unknown> {
  if ((await sha256File(executable)) !== expectedSha256) {
    throw new Error('Native browser importer changed after signature verification.');
  }
  const transportKey = createTransportKey();
  try {
    // Built from bytes, not strings, so every copy of the keys can be wiped.
    const encodedTransport = base64Bytes(transportKey);
    const encodedSaved = savedKey ? base64Bytes(savedKey) : Buffer.alloc(0);
    const input = savedKey ? Buffer.concat([encodedTransport, Buffer.from('\n'), encodedSaved]) : encodedTransport;
    let child: Awaited<ReturnType<typeof runNativeChild>>;
    try {
      child = await runNativeChild(executable, args, input);
    } finally {
      input.fill(0);
      encodedTransport.fill(0);
      encodedSaved.fill(0);
    }
    if (child.stdoutBytes > NATIVE_OUTPUT_LIMIT) throw new Error('Native browser importer returned too much data.');
    if (child.exitCode !== 0) {
      throw new Error(
        child.stderr.toString('utf8').trim() || `Native browser importer exited with code ${child.exitCode}.`
      );
    }
    return openEnvelope(child.stdout, transportKey);
  } finally {
    transportKey.fill(0);
  }
}

function openEnvelope(stdout: Buffer, transportKey: Buffer): unknown {
  const envelope = JSON.parse(stdout.toString('utf8')) as Record<string, unknown>;
  if (envelope.version !== 1) throw new Error('Native password importer returned an invalid envelope.');
  const nonce = Buffer.from(String(envelope.nonce || ''), 'base64');
  const sealed = Buffer.from(String(envelope.ciphertext || ''), 'base64');
  if (nonce.length !== 12 || sealed.length < 16) {
    throw new Error('Native password importer returned an invalid envelope.');
  }
  const ciphertext = sealed.subarray(0, sealed.length - 16);
  const authTag = sealed.subarray(sealed.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', transportKey, nonce);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  try {
    return JSON.parse(plaintext.toString('utf8'));
  } finally {
    plaintext.fill(0);
  }
}
