// Traversal-guarded project directory listing, editor read/stat/in-place write,
// tree mutations, and code-graph symbol lookup. Every function receives a
// resolved project root from the service project registry.
import { isUtf8 } from 'node:buffer';
import { existsSync, realpathSync } from 'node:fs';
import { cp, type FileHandle, lstat, mkdir, open, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { toUSVString } from 'node:util';

import { isFileFsyncUnsupported } from '../../../../src/runtime/shared/atomic-file.mjs';
import { codeGraphModuleUrl } from './desktop-support';
import { ProjectRecoveryError } from '../shared/project-recovery';
import { withFileIdentities, withProjectMutationPaths } from './project-mutation-queue';
import {
  beginProjectRecovery,
  RECOVERY_MAX_BYTES,
  recoveryIdentity,
  recoveryReadBytes,
  RecoveryReadLimitError,
  releaseRecoveryDirectory,
  sameRecoveryIdentity,
  writeRecoveryState,
  retireRecoveryDirectory,
  removeRecoveryDirectory,
  type RecoveryIdentity,
  type RecoveryPreparedFile,
} from './project-recovery-store';

export type ProjectTextEncoding = 'utf8' | 'utf8bom' | 'utf16le' | 'utf16be';

function decodeUtf16Be(bytes: Buffer): string {
  const swapped = Buffer.allocUnsafe(bytes.length - (bytes.length % 2));
  for (let index = 0; index < swapped.length; index += 2) {
    swapped[index] = bytes[index + 1];
    swapped[index + 1] = bytes[index];
  }
  return swapped.toString('utf16le');
}

interface DecodedProjectText {
  content: string;
  encoding: ProjectTextEncoding;
  binary: boolean;
  hasBom: boolean;
  lossless: boolean;
}

function decodeTextPayload(
  bytes: Buffer,
  encoding: ProjectTextEncoding,
  hasBom: boolean,
  binary = false
): DecodedProjectText {
  const utf16 = encoding === 'utf16le' || encoding === 'utf16be';
  const nodeEncoding = utf16 ? 'utf16le' : 'utf8';
  const text = encoding === 'utf16be' ? decodeUtf16Be(bytes) : bytes.toString(nodeEncoding);
  // Replacement characters are safe for display only. A literal U+FFFD in a
  // valid file is not an error; validate the bytes/code units, not that glyph.
  const content = toUSVString(text);
  const lossless = utf16 ? bytes.length % 2 === 0 && content === text : isUtf8(bytes);
  return { content, encoding, binary, hasBom, lossless };
}

/** Retain BOM presence independently of the encoding. Ambiguous BOM-less
 * UTF-16 keeps the existing NUL-lane heuristic. Malformed text can be viewed,
 * but its replacement-decoded display is never evidence for a safe write. */
export function decodeProjectText(bytes: Buffer): DecodedProjectText {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return decodeTextPayload(bytes.subarray(3), 'utf8bom', true);
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return decodeTextPayload(bytes.subarray(2), 'utf16le', true);
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return decodeTextPayload(bytes.subarray(2), 'utf16be', true);
  }
  const sample = bytes.subarray(0, Math.min(bytes.length - (bytes.length % 2), 8_192));
  let evenNuls = 0;
  let oddNuls = 0;
  for (let index = 0; index < sample.length; index += 2) {
    if (sample[index] === 0) evenNuls += 1;
    if (sample[index + 1] === 0) oddNuls += 1;
  }
  const pairs = sample.length / 2;
  if (pairs >= 4 && oddNuls / pairs > 0.6 && evenNuls / pairs < 0.1) {
    return decodeTextPayload(bytes, 'utf16le', false);
  }
  if (pairs >= 4 && evenNuls / pairs > 0.6 && oddNuls / pairs < 0.1) {
    return decodeTextPayload(bytes, 'utf16be', false);
  }
  return decodeTextPayload(bytes, 'utf8', false, bytes.subarray(0, 8_192).includes(0));
}

function encodeProjectText(content: string, encoding: ProjectTextEncoding, hasBom: boolean): Buffer {
  if (toUSVString(content) !== content) throw new TypeError('File content contains unpaired Unicode surrogates.');
  if (encoding === 'utf8bom') {
    return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(content, 'utf8')]);
  }
  if (encoding === 'utf16le' || encoding === 'utf16be') {
    const bytes = Buffer.from(content, 'utf16le');
    if (encoding === 'utf16be') bytes.swap16();
    if (!hasBom) return bytes;
    const bom = encoding === 'utf16le' ? [0xff, 0xfe] : [0xfe, 0xff];
    return Buffer.concat([Buffer.from(bom), bytes]);
  }
  return Buffer.from(content, 'utf8');
}

function requireLosslessText(decoded: DecodedProjectText): void {
  if (!decoded.lossless) {
    throw new Error('File has invalid text encoding. Convert or repair it in an external editor before saving.');
  }
}

function comparablePath(path: string): string {
  return process.platform === 'win32' ? path.toLocaleLowerCase() : path;
}

function canonicalPathThroughExistingAncestor(path: string): string {
  let existing = path;
  const missing: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    missing.unshift(basename(existing));
    existing = parent;
  }
  return resolve(realpathSync(existing), ...missing);
}

/** Traversal- and symlink-guarded absolute path for a project-relative entry. */
export function projectEntryPathIn(root: string, relPath: string): string {
  const absoluteRoot = resolve(root);
  const rel = String(relPath || '').replace(/\\/g, '/');
  const target = resolve(absoluteRoot, rel);
  if (target !== absoluteRoot && !target.startsWith(absoluteRoot + sep)) {
    throw new Error('Path is outside the project.');
  }
  const canonicalRoot = realpathSync(absoluteRoot);
  const canonicalTarget = canonicalPathThroughExistingAncestor(target);
  const rootKey = comparablePath(canonicalRoot);
  const targetKey = comparablePath(canonicalTarget);
  if (targetKey !== rootKey && !targetKey.startsWith(rootKey + sep)) {
    throw new Error('Path resolves outside the project.');
  }
  return target;
}

/** Claim lexical paths AND their resolved aliases. Revalidate after waiting:
 * a changed symlink must not redirect a queued operation outside its claim. */
function mutateProjectEntries<T>(root: string, relPaths: string[], run: () => Promise<T>): Promise<T> {
  const paths = () =>
    relPaths.flatMap((relPath) => {
      const path = projectEntryPathIn(root, relPath);
      return [path, canonicalPathThroughExistingAncestor(path)];
    });
  const claimed = paths();
  return withProjectMutationPaths(claimed, async () => {
    if (paths().some((path, index) => path !== claimed[index])) {
      throw new Error('Project path changed while waiting. Retry the operation.');
    }
    return run();
  });
}

/** Dock Files tab: one lazy directory level inside a registered project.
 *  Traversal-guarded — the resolved target stays under the project
 *  root. One directory level is loaded per request. */
export async function listProjectDirIn(root: string, relDir: string): Promise<Array<{ name: string; dir: boolean }>> {
  const target = projectEntryPathIn(root, relDir);
  const entries = await readdir(target, { withFileTypes: true });
  return entries
    .map((entry) => ({ name: entry.name, dir: entry.isDirectory() }))
    .sort((a, b) => {
      if (a.dir === b.dir) return a.name.localeCompare(b.name);
      return a.dir ? -1 : 1;
    });
}

/** Editable text up to 1 MB; larger text up to 10 MB opens read-only. */
export const PROJECT_TEXT_EDIT_MAX_BYTES = 1_048_576;
export const PROJECT_TEXT_VIEW_MAX_BYTES = 10_485_760;

/** Editor tab: read a project text file (1 MB edit cap, 10 MB read-only cap, binary sniff). */
export async function readProjectTextFileIn(root: string, relPath: string): Promise<ProjectTextFile> {
  const file = projectEntryPathIn(root, relPath);
  const info = await stat(file);
  if (!info.isFile()) throw new Error('Not a file.');
  if (info.size > PROJECT_TEXT_VIEW_MAX_BYTES) return projectTextTooLarge(info.mtimeMs);
  return projectTextReply(await readFile(file), info.mtimeMs);
}

export interface ProjectTextFile {
  content: string;
  mtimeMs: number;
  binary: boolean;
  tooLarge: boolean;
  readOnly?: boolean;
  readOnlyReason?: 'encoding';
  encoding: ProjectTextEncoding;
}

function projectTextTooLarge(mtimeMs: number): ProjectTextFile {
  return { content: '', mtimeMs, binary: false, tooLarge: true, encoding: 'utf8' };
}

/** readProjectTextFileIn for a file already open and authorized by the
 *  caller (a paired device's read): every byte comes through `handle`. */
export async function readProjectTextFileThrough(handle: FileHandle): Promise<ProjectTextFile> {
  const info = await handle.stat();
  if (!info.isFile()) throw new Error('Not a file.');
  if (info.size > PROJECT_TEXT_VIEW_MAX_BYTES) return projectTextTooLarge(info.mtimeMs);
  return projectTextReply(await handle.readFile(), info.mtimeMs);
}

function projectTextReply(bytes: Buffer, mtimeMs: number): ProjectTextFile {
  const decoded = decodeProjectText(bytes);
  const readOnly = !decoded.binary && (!decoded.lossless || bytes.length > PROJECT_TEXT_EDIT_MAX_BYTES);
  return {
    content: decoded.binary ? '' : decoded.content,
    mtimeMs,
    binary: decoded.binary,
    tooLarge: false,
    ...(readOnly ? { readOnly: true } : {}),
    ...(!decoded.binary && !decoded.lossless ? { readOnlyReason: 'encoding' as const } : {}),
    encoding: decoded.encoding,
  };
}

/** Editor tab external-change polling. */
export async function statProjectFileIn(
  root: string,
  relPath: string
): Promise<{ mtimeMs: number; size: number; directory: boolean }> {
  const info = await stat(projectEntryPathIn(root, relPath));
  return { mtimeMs: info.mtimeMs, size: info.size, directory: info.isDirectory() };
}

/** Editor F12 / Shift+F12: symbol lookup through the bundled code graph.
 *  Returns the tool's text output; the renderer extracts path:line anchors. */
export async function codeGraphQueryIn(
  root: string,
  mode: 'find_symbol' | 'references' | 'symbols',
  query: string,
  env: {
    packaged: boolean;
    resourcesPath: string;
    appPath: string | undefined;
    executeCodeGraphTool?: (name: string, args: Record<string, unknown>, cwd: string) => Promise<unknown>;
  }
): Promise<string> {
  const trimmed = query.trim();
  if (!trimmed || trimmed.length > (mode === 'symbols' ? 1_024 : 256)) {
    throw new TypeError(mode === 'symbols' ? 'File path is invalid.' : 'Symbol is invalid.');
  }
  const args = mode === 'symbols' ? { mode, files: trimmed, limit: 200 } : { mode, symbols: trimmed, limit: 20 };
  let execute = env.executeCodeGraphTool;
  if (!execute) {
    const moduleUrl = codeGraphModuleUrl(env.packaged, env.resourcesPath, env.appPath);
    const graph = (await import(/* @vite-ignore */ moduleUrl)) as {
      executeCodeGraphTool(name: string, args: Record<string, unknown>, cwd: string): Promise<unknown>;
    };
    execute = graph.executeCodeGraphTool;
  }
  const result = await execute('code_graph', args, root);
  return String(result ?? '');
}

/** Editor saves serialize with overlapping project mutations in this process.
 * The file is rewritten in place (see replaceProjectFileBytes), after its
 * content is rechecked through the same handle. Uncooperative writers (other
 * processes, shell/agent tools, OS trash) are not locked: the last check/write
 * gap is NOT an atomic filesystem compare-and-swap against those writers. */
export async function writeProjectTextFileIn(
  root: string,
  relPath: string,
  content: string,
  expectedContent: string,
  encoding?: ProjectTextEncoding
): Promise<{ mtimeMs: number }> {
  return mutateProjectEntries(root, [relPath], () =>
    writeProjectTextFileUnlocked(root, relPath, content, expectedContent, encoding)
  );
}

function assertProjectTextWrite(content: unknown, expectedContent: unknown, encoding: unknown): void {
  if (typeof content !== 'string' || content.length > 4_194_304) throw new TypeError('File content is invalid.');
  if (typeof expectedContent !== 'string' || expectedContent.length > 4_194_304) {
    throw new TypeError('Expected file content is invalid.');
  }
  if (
    encoding !== undefined &&
    encoding !== 'utf8' &&
    encoding !== 'utf8bom' &&
    encoding !== 'utf16le' &&
    encoding !== 'utf16be'
  ) {
    throw new TypeError('File encoding is invalid.');
  }
}

/** Opens a project file (absolute path) read-write, already authorized: the
 *  caller's proof that the open file is where it may write. */
export type AuthorizedFileOpener = (absolute: string) => Promise<FileHandle>;

/** The current text of an authorized handle, checked as a save's precondition:
 *  lossless text equal to `expectedContent`. */
async function expectedHandleText(
  handle: FileHandle,
  expectedContent: string,
  label: string
): Promise<{ bytes: Buffer; decoded: DecodedProjectText }> {
  const info = await handle.stat();
  if (!info.isFile()) throw new Error('Not a file.');
  if (info.size > PROJECT_TEXT_VIEW_MAX_BYTES) throw new Error(`File changed on disk: ${label}`);
  const bytes = await handle.readFile();
  const decoded = decodeProjectText(bytes);
  requireLosslessText(decoded);
  if (decoded.binary || decoded.content !== expectedContent) {
    throw new Error('File changed on disk. Reload or keep your edits before saving.');
  }
  return { bytes, decoded };
}

/** The identity of the file a handle holds: the same through every hard link. */
export async function handleIdentity(handle: FileHandle): Promise<RecoveryIdentity> {
  const info = await handle.stat({ bigint: true });
  return { dev: String(info.dev), ino: String(info.ino) };
}

export const identityKey = ({ dev, ino }: RecoveryIdentity): string => `${dev}:${ino}`;

/** Called once a save holds its file's identity claim: waiting for another
 *  writer may have outlasted the path, so it must still name the file that was
 *  opened and claimed, not a replacement or a retargeted link. */
export function assertPathNamesFile(file: string, identity: RecoveryIdentity): void {
  if (!sameRecoveryIdentity(recoveryIdentity(file), identity)) {
    throw new Error('Project path changed while waiting. Retry the operation.');
  }
}

/** Replaces every byte of the open file with `bytes`, in place. A filesystem
 *  that refuses to flush (network and cloud-sync drives) keeps a best-effort
 *  save; any other flush error fails it. */
export async function rewriteFileThrough(handle: FileHandle, bytes: Buffer): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, offset);
    if (bytesWritten < 1) throw new Error('File write made no progress.');
    offset += bytesWritten;
  }
  await handle.truncate(bytes.length);
  await handle.datasync().catch((error: unknown) => {
    if (!isFileFsyncUnsupported(error)) throw error;
  });
}

/** rewriteFileThrough, undone on failure: an in-place write is not atomic, so
 *  the original bytes (just verified as the file's content) are written back
 *  through the same handle when it fails part-way. */
async function rewriteFileOrRestore(handle: FileHandle, bytes: Buffer, original: Buffer): Promise<void> {
  try {
    await rewriteFileThrough(handle, bytes);
  } catch (error) {
    try {
      await rewriteFileThrough(handle, original);
    } catch {
      throw new Error(`Save failed: ${writeFailureMessage(error)}. The original could not be restored.`, {
        cause: error,
      });
    }
    throw error;
  }
}

/** writeProjectTextFileIn for a paired device: the file is opened through
 *  `openFile`, which authorizes the open file's real location, and read,
 *  checked and rewritten through that one handle — in place, since a rename
 *  would replace a path rather than the file that was authorized. Because an
 *  in-place write is not atomic, the original bytes are kept and put back
 *  through the same handle if the write fails. */
export async function writeProjectTextFileThrough(
  root: string,
  relPath: string,
  content: string,
  expectedContent: string,
  encoding: ProjectTextEncoding | undefined,
  openFile: AuthorizedFileOpener
): Promise<{ mtimeMs: number }> {
  assertProjectTextWrite(content, expectedContent, encoding);
  return mutateProjectEntries(root, [relPath], async () => {
    const handle = await openFile(projectEntryPathIn(root, relPath));
    try {
      const identity = await handleIdentity(handle);
      // Held across the check, the write and any restore: a hard link to this
      // file is another path the claims above do not cover.
      return await withFileIdentities([identityKey(identity)], async () => {
        assertPathNamesFile(projectEntryPathIn(root, relPath), identity);
        const { bytes: original, decoded } = await expectedHandleText(handle, expectedContent, relPath);
        const bytes = encodeProjectText(
          content,
          encoding ?? decoded.encoding,
          encoding === undefined ? decoded.hasBom : true
        );
        await rewriteFileOrRestore(handle, bytes, original);
        return { mtimeMs: (await handle.stat()).mtimeMs };
      });
    } finally {
      await handle.close();
    }
  });
}

/** writeProjectTextFilesIn for a paired device: every file is opened and
 *  authorized through `openFile` and checked before the first byte is
 *  written, then rewritten in place through its own handle. A failure puts
 *  back the bytes of every file already written, through the same handles. */
export async function writeProjectTextFilesThrough(
  root: string,
  writes: ReadonlyArray<{ relPath: string; content: string; expectedContent: string }>,
  openFile: AuthorizedFileOpener,
  recoveryDataPath?: string
): Promise<void> {
  if (!Array.isArray(writes) || writes.length < 1 || writes.length > 100) {
    throw new TypeError('Workspace edit files are invalid.');
  }
  const normalized = writes.map((write) => ({ ...write, relPath: String(write.relPath || '').replace(/\\/g, '/') }));
  if (new Set(normalized.map((write) => write.relPath.toLocaleLowerCase())).size !== normalized.length) {
    throw new TypeError('Workspace edit contains duplicate files.');
  }
  for (const write of normalized) assertProjectTextWrite(write.content, write.expectedContent, undefined);
  return mutateProjectEntries(
    root,
    normalized.map((write) => write.relPath),
    async () => {
      const handles: FileHandle[] = [];
      try {
        for (const write of normalized) handles.push(await openFile(projectEntryPathIn(root, write.relPath)));
        const identities = await Promise.all(handles.map(handleIdentity));
        const keys = identities.map(identityKey);
        // Two links of one file would both pass the check below, then the
        // second write would silently replace the first.
        if (new Set(keys).size !== keys.length) throw new TypeError('Workspace edit contains duplicate files.');
        // Every file is claimed at once, held through the checks, the writes
        // and the restore: a hard link is another path the claims above miss.
        await withFileIdentities(keys, async () => {
          const opened: Array<{ handle: FileHandle; relPath: string; before: Buffer; after: Buffer }> = [];
          for (const [index, write] of normalized.entries()) {
            assertPathNamesFile(projectEntryPathIn(root, write.relPath), identities[index]);
            const { bytes, decoded } = await expectedHandleText(handles[index], write.expectedContent, write.relPath);
            opened.push({
              handle: handles[index],
              relPath: write.relPath,
              before: bytes,
              after: encodeProjectText(write.content, decoded.encoding, decoded.hasBom),
            });
          }
          // The same host-owned recovery record as writeProjectTextFilesIn,
          // published before the first byte is written.
          const journal = recoveryDataPath
            ? await beginProjectRecovery(recoveryDataPath, root, await openedRecoveryFiles(root, opened))
            : undefined;
          const written: typeof opened = [];
          const restored = new Set<string>();
          let failed = false;
          let failure: unknown;
          try {
            for (const file of opened) {
              // Recorded before the write: a failure part-way through this file
              // leaves it modified, and it is restored with the earlier ones.
              written.push(file);
              await rewriteFileThrough(file.handle, file.after);
            }
          } catch (error) {
            failed = true;
            failure = error;
            const unrestored: string[] = [];
            for (const file of written.reverse()) {
              await rewriteFileThrough(file.handle, file.before).then(
                () => restored.add(file.relPath),
                () => unrestored.push(file.relPath)
              );
            }
            if (unrestored.length) {
              failure = new Error(
                `Workspace edit failed: ${writeFailureMessage(error)}. Not restored: ${JSON.stringify(unrestored)}.`,
                { cause: error }
              );
            }
          }
          await settleRecoveryJournal(journal, failed, failure, restored);
        });
      } finally {
        await Promise.all(handles.map((handle) => handle.close().catch(() => undefined)));
      }
    }
  );
}

/** Recovery entries for files opened through authorized handles: each one's
 *  destination is where its handle really is, confirmed by identity. */
async function openedRecoveryFiles(
  root: string,
  opened: ReadonlyArray<{ handle: FileHandle; relPath: string; before: Buffer; after: Buffer }>
): Promise<RecoveryPreparedFile[]> {
  let bytes = 0;
  const prepared: RecoveryPreparedFile[] = [];
  for (const file of opened) {
    bytes += file.before.length + file.after.length;
    if (bytes > RECOVERY_MAX_BYTES) {
      throw new ProjectRecoveryError(
        'RECOVERY_BATCH_LIMIT',
        'Workspace edit exceeds the 16 MiB recovery budget. Split the edit.'
      );
    }
    const destination = realpathSync(projectEntryPathIn(root, file.relPath));
    const info = await file.handle.stat({ bigint: true });
    const named = recoveryIdentity(destination);
    if (named.dev !== String(info.dev) || named.ino !== String(info.ino)) {
      throw new Error(`Project path changed before saving: ${file.relPath}`);
    }
    prepared.push({
      relPath: file.relPath,
      destination,
      parent: recoveryIdentity(dirname(destination)),
      mode: Number(info.mode),
      before: file.before,
      after: file.after,
    });
  }
  return prepared;
}

type ProjectFileReplacement = {
  before: Buffer;
  after: Buffer;
  destination: string;
};

// Resolve the parent, not the leaf: neither a save nor recovery may follow a
// retargeted directory alias. A symlinked leaf is written through to its
// target, which projectEntryPathIn keeps inside the project.
function replacementDestination(file: string): string {
  // Queue keys deliberately over-serialize case variants. Destination identity
  // must retain case: A/file and a/file can be different replacement targets.
  return join(realpathSync(dirname(file)), basename(file));
}

// Caller owns the complete mutation claim, including a batch's rollback.
async function writeProjectTextFileUnlocked(
  root: string,
  relPath: string,
  content: string,
  expectedContent: string,
  encoding?: ProjectTextEncoding,
  onCommitted?: (replacement: ProjectFileReplacement) => void,
  expectedDestination?: string,
  expectedBytes?: Buffer,
  validatePreparedTarget?: () => void
): Promise<{ mtimeMs: number }> {
  assertProjectTextWrite(content, expectedContent, encoding);
  const file = projectEntryPathIn(root, relPath);
  // Own the destination before the first asynchronous read. A batch passes
  // its preflight identity, so earlier writes cannot retarget a later entry.
  const destination = expectedDestination ?? replacementDestination(file);
  const validatePath = () => {
    validatePreparedTarget?.();
    projectEntryPathIn(root, relPath);
    if (replacementDestination(file) !== destination) {
      throw new Error('Project path changed before saving.');
    }
  };
  validatePath();
  const currentBytes = await readFile(file);
  if (expectedBytes && !currentBytes.equals(expectedBytes)) {
    throw new Error('File bytes changed after recovery preparation. Reload before saving.');
  }
  const current = decodeProjectText(currentBytes);
  requireLosslessText(current);
  if (current.binary || current.content !== expectedContent) {
    throw new Error('File changed on disk. Reload or keep your edits before saving.');
  }
  const info = await stat(file);
  if (!info.isFile()) throw new Error('Not a file.');
  const targetEncoding = encoding ?? current.encoding;
  // Ordinary saves preserve the observed BOM; an explicit encoding keeps
  // the existing conversion contract, including a BOM for UTF-16.
  const bytes = encodeProjectText(content, targetEncoding, encoding === undefined ? current.hasBom : true);
  await replaceProjectFileBytes(
    file,
    bytes,
    currentBytes,
    () => {
      // Record the successful write before any fallible post-commit metadata
      // lookup. A batch must roll this file back even when the stat below fails.
      onCommitted?.({ before: currentBytes, after: bytes, destination });
    },
    validatePath
  );
  return { mtimeMs: (await stat(file)).mtimeMs };
}

/** Shared in-place byte replacement for forward saves, batch rollback and
 * exact-byte recovery. The file is opened once, compared, rewritten and
 * flushed through that one handle, so it keeps its identity — file ID, hard
 * links, ACLs, attributes — and a symlink is written through to its target.
 * Never creates a file. In-process failures restore the original bytes through
 * the same handle; a crash mid-write is not atomic (batches publish a recovery
 * record first). The optional commit observer is internal and synchronous. A
 * completed rollback does not depend on a subsequent metadata lookup. Callers
 * own the mutation claim and path validation; this helper is not an exposed
 * RPC. */
export async function replaceProjectFileBytes(
  file: string,
  bytes: Buffer,
  expectedBytes: Buffer,
  onCommitted?: () => void,
  validatePath?: () => void
): Promise<void> {
  validatePath?.();
  const handle = await open(file, 'r+');
  try {
    const identity = await handleIdentity(handle);
    // A hard link is another path to this file, one the path claims cannot see:
    // take the file's identity once it is open, and hold it across the compare,
    // the write and any restore so no other save interleaves with them.
    await withFileIdentities([identityKey(identity)], async () => {
      // Re-validate with the file claimed: a directory alias or the file itself
      // retargeted before the open, or while waiting, must not receive the write.
      validatePath?.();
      assertPathNamesFile(file, identity);
      // Compare the bytes we actually observed, not a potentially lossy text
      // decoding. Never roll back over a newer external edit or BOM change.
      if (!(await handle.readFile()).equals(expectedBytes)) {
        throw new Error('File changed on disk. Reload or keep your edits before saving.');
      }
      validatePath?.();
      await rewriteFileOrRestore(handle, bytes, expectedBytes);
      onCommitted?.();
    });
  } finally {
    await handle.close();
  }
}

export type ProjectTextBatchFailure = {
  failedPath: string;
  committedPaths: readonly string[];
  restoredPaths: readonly string[];
  unrestoredPaths: readonly string[];
};

type ProjectTextRollbackFailure = { relPath: string; cause: unknown };

function writeFailureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Direct callers retain structured recovery evidence and the original cause.
 * All recovery information needed for manual intervention is also in message:
 * existing desktop/remote transports do not preserve arbitrary Error fields. */
export class ProjectTextBatchWriteError extends Error {
  readonly code: string;
  readonly result: ProjectTextBatchFailure;
  readonly rollbackFailures: readonly ProjectTextRollbackFailure[];

  constructor(
    cause: unknown,
    result: ProjectTextBatchFailure,
    rollbackFailures: readonly ProjectTextRollbackFailure[]
  ) {
    const failures = rollbackFailures.map(
      ({ relPath, cause: failure }) => `${JSON.stringify(relPath)} (${writeFailureMessage(failure)})`
    );
    const recovery = failures.length
      ? `Rollback incomplete. Not restored: ${failures.join('; ')}. Inspect these files before retrying.`
      : 'All committed files were restored.';
    super(
      `Workspace edit failed at ${JSON.stringify(result.failedPath)}: ${writeFailureMessage(cause)}. ` +
        `Committed: ${JSON.stringify(result.committedPaths)}. Restored: ${JSON.stringify(result.restoredPaths)}. ${recovery}`,
      { cause }
    );
    this.name = 'ProjectTextBatchWriteError';
    this.code = rollbackFailures.length ? 'EPARTIAL_WRITE' : 'EWORKSPACE_WRITE';
    this.result = result;
    this.rollbackFailures = rollbackFailures;
  }
}

/** Closed-file half of an LSP WorkspaceEdit. Each replacement and in-process
 * rollback owns one batch claim. An optional host-owned data directory also
 * publishes exact before/after bytes before the first mutation for restart
 * inspection. External writers remain outside the atomicity guarantee. */
export async function writeProjectTextFilesIn(
  root: string,
  writes: ReadonlyArray<{ relPath: string; content: string; expectedContent: string }>,
  recoveryDataPath?: string
): Promise<void> {
  if (!Array.isArray(writes) || writes.length < 1 || writes.length > 100) {
    throw new TypeError('Workspace edit files are invalid.');
  }
  const normalized = writes.map((write) => ({
    relPath: String(write.relPath || '').replace(/\\/g, '/'),
    content: write.content,
    expectedContent: write.expectedContent,
  }));
  if (new Set(normalized.map((write) => write.relPath.toLocaleLowerCase())).size !== normalized.length) {
    throw new TypeError('Workspace edit contains duplicate files.');
  }
  return mutateProjectEntries(
    root,
    normalized.map((write) => write.relPath),
    async () => {
      const rootPath = realpathSync(root);
      const rootIdentity = recoveryDataPath ? recoveryIdentity(root) : undefined;
      const validateRoot = () => {
        if (
          rootIdentity &&
          (realpathSync(root) !== rootPath || !sameRecoveryIdentity(recoveryIdentity(root), rootIdentity))
        ) {
          throw new Error('Project root changed during recovery preparation.');
        }
      };
      // Resolve every destination before asynchronous preflight reads.
      const destinations = new Map(
        normalized.map(({ relPath }) => [relPath, replacementDestination(projectEntryPathIn(root, relPath))])
      );
      const parents = recoveryDataPath
        ? new Map([...destinations].map(([rel, destination]) => [rel, recoveryIdentity(dirname(destination))]))
        : null;
      const prepared: RecoveryPreparedFile[] = [];
      let recoveryBytes = 0;
      for (const write of normalized) {
        if (
          !write.relPath ||
          typeof write.content !== 'string' ||
          typeof write.expectedContent !== 'string' ||
          write.content.length > 4_194_304 ||
          write.expectedContent.length > 4_194_304
        ) {
          throw new TypeError('Workspace edit file content is invalid.');
        }
        if (toUSVString(write.content) !== write.content) {
          throw new TypeError('File content contains unpaired Unicode surrogates.');
        }
        const file = projectEntryPathIn(root, write.relPath);
        const before = recoveryDataPath
          ? await recoveryReadBytes(file, RECOVERY_MAX_BYTES - recoveryBytes).catch((error) => {
              if (error instanceof RecoveryReadLimitError)
                throw new ProjectRecoveryError(
                  'RECOVERY_BATCH_LIMIT',
                  'Workspace edit exceeds the 16 MiB recovery budget. Split the edit.',
                  { cause: error }
                );
              throw error;
            })
          : await readFile(file);
        const current = decodeProjectText(before);
        requireLosslessText(current);
        if (current.binary || current.content !== write.expectedContent) {
          throw new Error(`File changed on disk: ${write.relPath}`);
        }
        if (recoveryDataPath) {
          validateRoot();
          const destination = destinations.get(write.relPath)!;
          if (replacementDestination(file) !== destination)
            throw new Error('Project path changed during recovery preparation.');
          const parent = parents!.get(write.relPath)!;
          if (!sameRecoveryIdentity(recoveryIdentity(dirname(destination)), parent)) {
            throw new Error('Project directory changed during recovery preparation.');
          }
          const after = encodeProjectText(write.content, current.encoding, current.hasBom);
          recoveryBytes += before.length + after.length;
          if (recoveryBytes > RECOVERY_MAX_BYTES)
            throw new ProjectRecoveryError(
              'RECOVERY_BATCH_LIMIT',
              'Workspace edit exceeds the 16 MiB recovery budget. Split the edit.'
            );
          const info = await lstat(file);
          if (!info.isFile() || info.isSymbolicLink())
            throw new Error('Journaled workspace edits require regular files.');
          prepared.push({ relPath: write.relPath, destination, parent, mode: info.mode, before, after });
        }
      }
      validateRoot();
      const journal = recoveryDataPath ? await beginProjectRecovery(recoveryDataPath, root, prepared) : undefined;
      const committed: Array<ProjectFileReplacement & { relPath: string }> = [];
      const restored = new Set<string>();
      let failedPath = '';
      let failed = false;
      let failure: unknown;
      try {
        validateRoot();
        for (let index = 0; index < normalized.length; index++) {
          const write = normalized[index];
          const entry = prepared[index];
          const validatePreparedTarget = entry
            ? () => {
                validateRoot();
                if (!sameRecoveryIdentity(recoveryIdentity(dirname(entry.destination)), entry.parent)) {
                  throw new Error('Project directory changed after recovery preparation.');
                }
              }
            : undefined;
          failedPath = write.relPath;
          await writeProjectTextFileUnlocked(
            root,
            write.relPath,
            write.content,
            write.expectedContent,
            undefined,
            (replacement) => {
              committed.push({ ...replacement, relPath: write.relPath });
            },
            destinations.get(write.relPath),
            entry?.before,
            validatePreparedTarget
          );
        }
      } catch (error) {
        failed = true;
        failure = error;
        // Preserve the original pre-commit error when no swap occurred.
        if (committed.length) {
          const rollbackFailures = await rollBackCommitted(root, committed, prepared, validateRoot, restored);
          const committedPaths = committed.map(({ relPath }) => relPath);
          failure = new ProjectTextBatchWriteError(
            error,
            {
              failedPath,
              committedPaths,
              restoredPaths: committedPaths.filter((path) => restored.has(path)),
              unrestoredPaths: committedPaths.filter((path) => !restored.has(path)),
            },
            rollbackFailures
          );
        }
      }
      await settleRecoveryJournal(journal, failed, failure, restored);
    }
  );
}

/** Restores committed replacements newest-first, recording each restored path
 *  and collecting the failures instead of stopping at the first. */
async function rollBackCommitted(
  root: string,
  committed: ReadonlyArray<ProjectFileReplacement & { relPath: string }>,
  prepared: ReadonlyArray<RecoveryPreparedFile>,
  validateRoot: () => void,
  restored: Set<string>
): Promise<ProjectTextRollbackFailure[]> {
  const rollbackFailures: ProjectTextRollbackFailure[] = [];
  for (const replacement of [...committed].reverse()) {
    try {
      const file = projectEntryPathIn(root, replacement.relPath);
      const preparedEntry = prepared.find((entry) => entry.relPath === replacement.relPath);
      const validatePath = () => {
        validateRoot();
        if (
          preparedEntry &&
          !sameRecoveryIdentity(recoveryIdentity(dirname(preparedEntry.destination)), preparedEntry.parent)
        ) {
          throw new Error('Project directory changed before rollback.');
        }
        projectEntryPathIn(root, replacement.relPath);
        if (replacementDestination(file) !== replacement.destination) {
          throw new Error('Project path changed before rollback.');
        }
      };
      await replaceProjectFileBytes(
        file,
        replacement.before,
        replacement.after,
        () => {
          restored.add(replacement.relPath);
        },
        validatePath
      );
    } catch (cause) {
      rollbackFailures.push({ relPath: replacement.relPath, cause });
    }
  }
  return rollbackFailures;
}

/** Settles a batch's recovery record once its writes have run: a completed
 *  batch retires it, a failed one keeps it, marked with what was restored.
 *  Rethrows the batch's failure, tagged with the record's id. */
async function settleRecoveryJournal(
  journal: { id: string; directory: string } | undefined,
  failed: boolean,
  failure: unknown,
  restored: ReadonlySet<string>
): Promise<void> {
  if (journal) {
    const journalErrors: unknown[] = [];
    try {
      await writeRecoveryState(journal.directory, {
        phase: failed ? 'failed' : 'complete',
        message: failed ? writeFailureMessage(failure) : '',
        restored: [...restored],
      });
      if (!failed) {
        journal.directory = await retireRecoveryDirectory(journal.directory);
        try {
          await removeRecoveryDirectory(journal.directory);
        } catch {
          /* Retired, never restorable. */
        }
      }
    } catch (error) {
      journalErrors.push(error);
    }
    try {
      await releaseRecoveryDirectory(journal.directory);
    } catch (error) {
      journalErrors.push(error);
    }
    if (journalErrors.length) {
      throw new AggregateError(
        failed ? [failure, ...journalErrors] : journalErrors,
        (failed
          ? 'Workspace edit failed; recovery bookkeeping also failed. Inspect retained recovery records.'
          : 'Files were saved, but recovery bookkeeping failed. Inspect retained recovery records before retrying.') +
          `\n[file-recovery] ${journal.id}`
      );
    }
  }
  if (failed) {
    if (journal && failure instanceof Error) failure.message += `\n[file-recovery] ${journal.id}`;
    throw failure;
  }
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: rejects C0 control characters (U+0000-U+001F) in file names on purpose.
const INVALID_ENTRY_SEGMENT = /[:*?"<>|\u0000-\u001f]/;

function explorerEntrySegments(name: string): string[] {
  const segments = String(name || '')
    .replace(/\\/g, '/')
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (!segments.length) throw new TypeError('Entry name is invalid.');
  for (const segment of segments) {
    if (INVALID_ENTRY_SEGMENT.test(segment) || segment === '.' || segment === '..') {
      throw new TypeError('Entry name is invalid.');
    }
  }
  return segments;
}

/** Files tree: create a file or directory. The
 *  name may contain "a/b/c" segments; missing parent folders are created. */
export async function createProjectEntryIn(root: string, relDir: string, name: string, dir: boolean): Promise<void> {
  const segments = explorerEntrySegments(name);
  const relTarget = join(String(relDir || ''), ...segments);
  return mutateProjectEntries(root, [relTarget], async () => {
    const target = projectEntryPathIn(root, relTarget);
    if (dir) {
      await mkdir(target, { recursive: true });
      return;
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, '', { encoding: 'utf8', flag: 'wx' });
  });
}

// Only absence authorizes a destination. Permission/IO failures are not absence;
// lstat also treats a dangling symlink as an occupied directory entry.
async function entryExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

/** Files tree: rename in place without replacing a distinct existing entry.
 * The check and rename are serialized with this module's mutations, not with
 * external processes. Node's portable rename API has no no-replace flag. */
export async function renameProjectEntryIn(root: string, relPath: string, newName: string): Promise<void> {
  const trimmed = String(newName || '').trim();
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejects C0 control characters (U+0000-U+001F) in file names on purpose.
  if (!trimmed || /[\\/:*?"<>|\u0000-\u001f]/.test(trimmed) || trimmed === '.' || trimmed === '..') {
    throw new TypeError('Entry name is invalid.');
  }
  const source = projectEntryPathIn(root, relPath);
  if (source === resolve(root)) throw new Error('Cannot rename the project root.');
  const destinationRel = join(dirname(relPath.replace(/\\/g, '/')), trimmed);
  return mutateProjectEntries(root, [relPath, destinationRel], async () => {
    const from = projectEntryPathIn(root, relPath);
    const destination = projectEntryPathIn(root, destinationRel);
    await lstat(from);
    if (from === destination) return;
    if (await entryExists(destination)) {
      const names = await readdir(dirname(from));
      const caseOnly =
        basename(from).toLowerCase() === trimmed.toLowerCase() &&
        names.includes(basename(from)) &&
        !names.includes(trimmed);
      if (!caseOnly) throw new Error('An entry with that name already exists in the target folder.');
    }
    await rename(from, destination);
  });
}

/** Files tree: move an entry into another project folder (Explorer DnD and
 *  cut/paste). Never overwrites; a same-name target is a hard error. */
export async function moveProjectEntryIn(root: string, relPath: string, targetDirRel: string): Promise<void> {
  return mutateProjectEntries(root, [relPath, targetDirRel], async () => {
    const source = projectEntryPathIn(root, relPath);
    if (source === resolve(root)) throw new Error('Cannot move the project root.');
    const targetDir = projectEntryPathIn(root, targetDirRel);
    if (!(await stat(targetDir)).isDirectory()) throw new Error('Move target is not a folder.');
    if (targetDir === source || targetDir.startsWith(source + sep)) {
      throw new Error('Cannot move a folder into itself.');
    }
    const destination = join(targetDir, basename(source));
    if (destination === source) return;
    if (await entryExists(destination)) {
      throw new Error('An entry with that name already exists in the target folder.');
    }
    await rename(source, destination);
  });
}

/** Files tree: copy an entry into a project folder. Collisions take the
 *  conventional paste name — "name copy", then "name copy 2", ... */
export async function copyProjectEntryIn(
  root: string,
  relPath: string,
  targetDirRel: string
): Promise<{ name: string }> {
  return mutateProjectEntries(root, [relPath, targetDirRel], async () => {
    const source = projectEntryPathIn(root, relPath);
    if (source === resolve(root)) throw new Error('Cannot copy the project root.');
    const targetDir = projectEntryPathIn(root, targetDirRel);
    if (!(await stat(targetDir)).isDirectory()) throw new Error('Copy target is not a folder.');
    if (targetDir === source || targetDir.startsWith(source + sep)) {
      throw new Error('Cannot copy a folder into itself.');
    }
    const sourceIsDir = (await stat(source)).isDirectory();
    const exists = (candidate: string) => entryExists(join(targetDir, candidate));
    let name = basename(source);
    if (await exists(name)) {
      const dot = sourceIsDir ? -1 : name.lastIndexOf('.');
      const stem = dot > 0 ? name.slice(0, dot) : name;
      const extension = dot > 0 ? name.slice(dot) : '';
      let counter = 0;
      while (await exists(name)) {
        counter += 1;
        name = counter === 1 ? `${stem} copy${extension}` : `${stem} copy ${counter}${extension}`;
      }
    }
    await cp(source, join(targetDir, name), { recursive: true, force: false, errorOnExist: true });
    return { name };
  });
}
