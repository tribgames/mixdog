// Where an OPEN file lives, read from the open file rather than from the path
// it was opened by. A check made on a resolved path covers the file a handle
// reads only once the handle is shown to be the file at that path: an
// ancestor directory swapped for a junction or symlink between resolving and
// opening redirects the open without changing the path string the check saw,
// and a stat of that path afterwards follows the same swapped ancestor. Any
// sequence of path lookups can be raced the same way, so only an answer tied
// to the open descriptor counts; a platform without one locates nothing, and
// nothing is authorized there.
import type { FileHandle } from 'node:fs/promises';
import { readlink } from 'node:fs/promises';
import { toNamespacedPath } from 'node:path';

/** The open file's dev/ino as its own fstat reports them. */
export interface OpenedFileIdentity {
  dev: bigint;
  ino: bigint;
}

/** A koffi function. A variadic one is called synchronously only. */
type NativeFunction = { (...args: unknown[]): unknown; async: (...args: unknown[]) => void };

/** The slice of koffi the locators load native functions through. */
export interface ForeignFunctions {
  load(library: string): { func(definition: string): NativeFunction };
}

/** The canonical absolute path of the file `handle` has open, now. `openedBy`
 *  is the path it was opened by and `identity` its fstat dev/ino. Rejects when
 *  the location cannot be established. */
export type OpenedFileLocator = (
  handle: Pick<FileHandle, 'fd'>,
  openedBy: string,
  identity: OpenedFileIdentity
) => Promise<string>;

/** The descriptor-based locator for `platform`, its native functions loaded
 *  through `foreign` on first use. */
export function openedFileLocator(
  platform: NodeJS.Platform,
  foreign: () => Promise<ForeignFunctions>
): OpenedFileLocator {
  // The kernel's own name for the open file description.
  if (platform === 'linux') return (handle) => readlink(`/proc/self/fd/${handle.fd}`);
  if (platform === 'win32') return windowsLocator(foreign);
  if (platform === 'darwin') return darwinLocator(foreign);
  // FreeBSD and the rest: no descriptor-based locator, so fail closed.
  return () => Promise.reject(new Error(`An open file cannot be located on ${platform}.`));
}

export const openedFilePath: OpenedFileLocator = openedFileLocator(process.platform, () =>
  import('koffi').then(({ default: koffi }) => koffi)
);

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

interface Kernel32 {
  createFile: NativeFunction;
  fileInformation: NativeFunction;
  finalPath: NativeFunction;
  closeHandle: NativeFunction;
}

function loadKernel32(foreign: () => Promise<ForeignFunctions>): Promise<Kernel32> {
  return foreign().then((ffi) => {
    const library = ffi.load('kernel32.dll');
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
}

/** Off the event loop: a junction can lead to a slow volume. */
function callAsync(native: NativeFunction, ...args: unknown[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    native.async(...args, (error: unknown, result: unknown) => (error ? reject(error) : resolve(result)));
  });
}

function windowsLocator(foreign: () => Promise<ForeignFunctions>): OpenedFileLocator {
  let kernel32: Promise<Kernel32> | null = null;
  return async (_handle, openedBy, identity) => {
    kernel32 ??= loadKernel32(foreign);
    return windowsFilePath(await kernel32, openedBy, identity);
  };
}

async function windowsFilePath(api: Kernel32, openedBy: string, identity: OpenedFileIdentity): Promise<string> {
  const file = Number(
    await callAsync(
      api.createFile,
      toNamespacedPath(openedBy),
      FILE_READ_ATTRIBUTES,
      FILE_SHARE_ALL,
      null,
      OPEN_EXISTING,
      0,
      null
    )
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

// ── macOS: fcntl(F_GETPATH) ──────────────────────────────────────────────────
// A Node fd is the real descriptor here, so the kernel names its file directly.

const F_GETPATH = 50;
const MAXPATHLEN = 1024;
const LIBSYSTEM = '/usr/lib/libSystem.B.dylib';

function darwinLocator(foreign: () => Promise<ForeignFunctions>): OpenedFileLocator {
  let fcntl: Promise<NativeFunction> | null = null;
  return async (handle) => {
    fcntl ??= foreign().then((ffi) => ffi.load(LIBSYSTEM).func('int fcntl(int fd, int cmd, ...)'));
    const getPath = await fcntl;
    const path = Buffer.alloc(MAXPATHLEN);
    // Variadic, so koffi calls it synchronously; the kernel answers from its
    // own records of the descriptor. The buffer is written in place.
    if (Number(getPath(handle.fd, F_GETPATH, 'uint8_t *', path)) === -1) {
      throw new Error('The open file cannot be located.');
    }
    const end = path.indexOf(0);
    if (end <= 0) throw new Error('The open file cannot be located.');
    return path.toString('utf8', 0, end);
  };
}
