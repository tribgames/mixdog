// Where an OPEN file lives, read from the open file rather than from the path
// it was opened by. A check made on a resolved path covers the file a handle
// reads only once the handle is shown to be the file at that path: an
// ancestor directory swapped for a junction or symlink between resolving and
// opening redirects the open without changing the path string the check saw,
// and a stat of that path afterwards follows the same swapped ancestor.
import type { FileHandle } from 'node:fs/promises';
import { lstat, readlink, realpath } from 'node:fs/promises';
import { dirname, toNamespacedPath } from 'node:path';

/** The open file's dev/ino as its own fstat reports them. */
export interface OpenedFileIdentity {
  dev: bigint;
  ino: bigint;
}

/** The canonical absolute path of the file `handle` has open, now. `openedBy`
 *  is the path it was opened by and `identity` its fstat dev/ino. Rejects when
 *  the location cannot be established. */
export function openedFilePath(handle: FileHandle, openedBy: string, identity: OpenedFileIdentity): Promise<string> {
  // The kernel's own name for the open file description.
  if (process.platform === 'linux') return readlink(`/proc/self/fd/${handle.fd}`);
  if (process.platform === 'win32') return windowsFilePath(openedBy, identity);
  return walkedFilePath(openedBy, identity);
}

// ── Windows: GetFinalPathNameByHandleW ───────────────────────────────────────
// A Node fd is a private CRT descriptor whose HANDLE native code cannot reach,
// so a second handle is opened and its final path is used only once its
// volume serial and file index prove it is the very file the fd has open.

const FILE_READ_ATTRIBUTES = 0x80;
const FILE_SHARE_ALL = 0x7;
const OPEN_EXISTING = 3;
const INVALID_HANDLE_VALUE = -1;
/** BY_HANDLE_FILE_INFORMATION: 13 DWORDs. */
const FILE_INFORMATION_BYTES = 52;
const VOLUME_SERIAL_OFFSET = 28;
const FILE_INDEX_HIGH_OFFSET = 44;
const FILE_INDEX_LOW_OFFSET = 48;
const MAX_PATH_CHARS = 32_768;

type NativeFunction = { (...args: unknown[]): unknown; async: (...args: unknown[]) => void };

interface Kernel32 {
  createFile: NativeFunction;
  fileInformation: NativeFunction;
  finalPath: NativeFunction;
  closeHandle: NativeFunction;
}

let kernel32: Promise<Kernel32> | null = null;

function loadKernel32(): Promise<Kernel32> {
  // Loaded on a Windows host only; servers are POSIX.
  kernel32 ??= import('koffi').then(({ default: koffi }) => {
    const library = koffi.load('kernel32.dll');
    return {
      createFile: library.func(
        'intptr_t __stdcall CreateFileW(const char16_t *name, uint32_t access, uint32_t share, void *security, uint32_t disposition, uint32_t flags, void *template)'
      ),
      fileInformation: library.func('int __stdcall GetFileInformationByHandle(intptr_t file, _Out_ uint8_t *info)'),
      finalPath: library.func(
        'uint32_t __stdcall GetFinalPathNameByHandleW(intptr_t file, _Out_ uint16_t *path, uint32_t length, uint32_t flags)'
      ),
      closeHandle: library.func('int __stdcall CloseHandle(intptr_t file)'),
    };
  });
  return kernel32;
}

/** Off the event loop: a junction can lead to a slow volume. */
function callAsync(native: NativeFunction, ...args: unknown[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    native.async(...args, (error: unknown, result: unknown) => (error ? reject(error) : resolve(result)));
  });
}

async function windowsFilePath(openedBy: string, identity: OpenedFileIdentity): Promise<string> {
  const api = await loadKernel32();
  const file = Number(
    await callAsync(api.createFile, toNamespacedPath(openedBy), FILE_READ_ATTRIBUTES, FILE_SHARE_ALL, null, OPEN_EXISTING, 0, null)
  );
  if (file === INVALID_HANDLE_VALUE) throw new Error('The open file cannot be located.');
  try {
    const info = Buffer.alloc(FILE_INFORMATION_BYTES);
    if (!(await callAsync(api.fileInformation, file, info))) throw new Error('The open file cannot be located.');
    const dev = BigInt(info.readUInt32LE(VOLUME_SERIAL_OFFSET));
    const ino =
      (BigInt(info.readUInt32LE(FILE_INDEX_HIGH_OFFSET)) << 32n) | BigInt(info.readUInt32LE(FILE_INDEX_LOW_OFFSET));
    if (dev !== identity.dev || ino !== identity.ino) throw new Error('The path no longer names the open file.');
    const path = Buffer.alloc(MAX_PATH_CHARS * 2);
    // FILE_NAME_NORMALIZED | VOLUME_NAME_DOS.
    const length = Number(await callAsync(api.finalPath, file, path, MAX_PATH_CHARS, 0));
    if (length === 0 || length >= MAX_PATH_CHARS) throw new Error('The open file cannot be located.');
    // The same form Node's realpath returns.
    return path
      .toString('utf16le', 0, length * 2)
      .replace(/^\\\\\?\\UNC\\/, '\\\\')
      .replace(/^\\\\\?\\/, '');
  } finally {
    api.closeHandle(file);
  }
}

// ── Elsewhere (macOS, BSD): no way to ask an open file its path ──────────────

/** A fresh resolution of `openedBy`, every directory on it re-checked to be
 *  a real directory, and the file there proven to be the open one. Exported
 *  so every host can test the fallback. */
export async function walkedFilePath(openedBy: string, identity: OpenedFileIdentity): Promise<string> {
  const at = await realpath(openedBy);
  for (let directory = dirname(at); ; directory = dirname(directory)) {
    if ((await lstat(directory)).isSymbolicLink()) throw new Error('The path to the open file changed.');
    if (dirname(directory) === directory) break;
  }
  const leaf = await lstat(at, { bigint: true });
  if (leaf.isSymbolicLink() || leaf.dev !== identity.dev || leaf.ino !== identity.ino) {
    throw new Error('The path no longer names the open file.');
  }
  return at;
}
