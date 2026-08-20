// Traversal-guarded project directory listing, editor read/stat/atomic-write,
// tree mutations, and code-graph symbol lookup. Every function receives a
// resolved project root from the service project registry.
import { existsSync, realpathSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';

import { codeGraphModuleUrl } from './desktop-support';

export type ProjectTextEncoding = 'utf8' | 'utf8bom' | 'utf16le' | 'utf16be';

function decodeUtf16Be(bytes: Buffer): string {
  const swapped = Buffer.allocUnsafe(bytes.length - (bytes.length % 2));
  for (let index = 0; index < swapped.length; index += 2) {
    swapped[index] = bytes[index + 1];
    swapped[index + 1] = bytes[index];
  }
  return swapped.toString('utf16le');
}

/** Decode editor text without erasing its on-disk encoding. UTF-16 files with
 * a BOM are always text; BOM-less UTF-16 is accepted only when its NUL-byte
 * lane is unambiguous, otherwise the normal binary guard wins. */
export function decodeProjectText(bytes: Buffer): {
  content: string;
  encoding: ProjectTextEncoding;
  binary: boolean;
} {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { content: bytes.subarray(3).toString('utf8'), encoding: 'utf8bom', binary: false };
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { content: bytes.subarray(2).toString('utf16le'), encoding: 'utf16le', binary: false };
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { content: decodeUtf16Be(bytes.subarray(2)), encoding: 'utf16be', binary: false };
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
    return { content: bytes.subarray(0, bytes.length - (bytes.length % 2)).toString('utf16le'), encoding: 'utf16le', binary: false };
  }
  if (pairs >= 4 && evenNuls / pairs > 0.6 && oddNuls / pairs < 0.1) {
    return { content: decodeUtf16Be(bytes), encoding: 'utf16be', binary: false };
  }
  return {
    content: bytes.toString('utf8'),
    encoding: 'utf8',
    binary: bytes.subarray(0, 8_192).includes(0),
  };
}

export function encodeProjectText(content: string, encoding: ProjectTextEncoding): Buffer {
  if (encoding === 'utf8bom') {
    return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(content, 'utf8')]);
  }
  if (encoding === 'utf16le') {
    return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(content, 'utf16le')]);
  }
  if (encoding === 'utf16be') {
    const littleEndian = Buffer.from(content, 'utf16le');
    const bigEndian = Buffer.allocUnsafe(littleEndian.length);
    for (let index = 0; index < littleEndian.length; index += 2) {
      bigEndian[index] = littleEndian[index + 1];
      bigEndian[index + 1] = littleEndian[index];
    }
    return Buffer.concat([Buffer.from([0xfe, 0xff]), bigEndian]);
  }
  return Buffer.from(content, 'utf8');
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

/** Dock Files tab: one lazy directory level inside a registered project.
 *  Traversal-guarded — the resolved target must stay under the project
 *  root. One directory level is loaded per request. */
export async function listProjectDirIn(root: string, relDir: string): Promise<Array<{ name: string; dir: boolean }>> {
  const target = projectEntryPathIn(root, relDir);
  const entries = await readdir(target, { withFileTypes: true });
  return entries
    .map((entry) => ({ name: entry.name, dir: entry.isDirectory() }))
    .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
}

/** Editor tab: read a project text file (1 MB cap, binary sniff). */
export async function readProjectTextFileIn(root: string, relPath: string): Promise<{
  content: string; mtimeMs: number; binary: boolean; tooLarge: boolean; encoding: ProjectTextEncoding;
}> {
  const file = projectEntryPathIn(root, relPath);
  const info = await stat(file);
  if (!info.isFile()) throw new Error('Not a file.');
  if (info.size > 1_048_576) {
    return { content: '', mtimeMs: info.mtimeMs, binary: false, tooLarge: true, encoding: 'utf8' };
  }
  const bytes = await readFile(file);
  const decoded = decodeProjectText(bytes);
  return {
    content: decoded.binary ? '' : decoded.content,
    mtimeMs: info.mtimeMs,
    binary: decoded.binary,
    tooLarge: false,
    encoding: decoded.encoding,
  };
}

/** Editor tab external-change polling. */
export async function statProjectFileIn(root: string, relPath: string): Promise<{ mtimeMs: number; size: number }> {
  const info = await stat(projectEntryPathIn(root, relPath));
  return { mtimeMs: info.mtimeMs, size: info.size };
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
    executeCodeGraphTool?: (
      name: string,
      args: Record<string, unknown>,
      cwd: string,
    ) => Promise<unknown>;
  },
): Promise<string> {
  const trimmed = query.trim();
  if (!trimmed || trimmed.length > (mode === 'symbols' ? 1_024 : 256)) {
    throw new TypeError(mode === 'symbols' ? 'File path is invalid.' : 'Symbol is invalid.');
  }
  const args = mode === 'symbols'
    ? { mode, files: trimmed, limit: 200 }
    : { mode, symbols: trimmed, limit: 20 };
  let execute = env.executeCodeGraphTool;
  if (!execute) {
    const moduleUrl = codeGraphModuleUrl(env.packaged, env.resourcesPath, env.appPath);
    const graph = await import(/* @vite-ignore */ moduleUrl) as {
      executeCodeGraphTool(
        name: string,
        args: Record<string, unknown>,
        cwd: string,
      ): Promise<unknown>;
    };
    execute = graph.executeCodeGraphTool;
  }
  const result = await execute('code_graph', args, root);
  return String(result ?? '');
}

/** Editor tab: content-version compare-and-swap followed by atomic replace.
 *  A deleted/renamed/externally changed file is never silently recreated or
 *  overwritten; the renderer must explicitly adopt the new disk version. */
export async function writeProjectTextFileIn(
  root: string,
  relPath: string,
  content: string,
  expectedContent: string,
  encoding?: ProjectTextEncoding,
): Promise<{ mtimeMs: number }> {
  if (typeof content !== 'string' || content.length > 4_194_304) throw new TypeError('File content is invalid.');
  if (typeof expectedContent !== 'string' || expectedContent.length > 4_194_304) {
    throw new TypeError('Expected file content is invalid.');
  }
  if (encoding !== undefined
    && encoding !== 'utf8'
    && encoding !== 'utf8bom'
    && encoding !== 'utf16le'
    && encoding !== 'utf16be') {
    throw new TypeError('File encoding is invalid.');
  }
  const file = projectEntryPathIn(root, relPath);
  const current = decodeProjectText(await readFile(file));
  if (current.binary || current.content !== expectedContent) {
    throw new Error('File changed on disk. Reload or keep your edits before saving.');
  }
  const info = await stat(file);
  if (!info.isFile()) throw new Error('Not a file.');
  const temp = `${file}.mixdog-save-${process.pid}-${Date.now()}`;
  const targetEncoding = encoding ?? current.encoding;
  try {
    await writeFile(temp, encodeProjectText(content, targetEncoding), { mode: info.mode });
    // Recheck immediately before the swap so a change during temp-file IO is
    // also rejected. The final rename remains atomic for readers.
    const rechecked = decodeProjectText(await readFile(file));
    if (rechecked.binary || rechecked.content !== expectedContent
      || rechecked.encoding !== current.encoding) {
      throw new Error('File changed on disk. Reload or keep your edits before saving.');
    }
    await rename(temp, file);
    return { mtimeMs: (await stat(file)).mtimeMs };
  } finally {
    await rm(temp, { force: true }).catch(() => {});
  }
}

/** Closed-file half of an LSP WorkspaceEdit. Every target is read and
 * compare-checked before any write begins; each replacement then reuses the
 * same atomic CAS writer as a normal editor save. If a later file fails,
 * already-written files are rolled back only while they still contain our
 * exact replacement, so an external edit is never overwritten. */
export async function writeProjectTextFilesIn(
  root: string,
  writes: ReadonlyArray<{ relPath: string; content: string; expectedContent: string }>,
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
  for (const write of normalized) {
    if (!write.relPath || typeof write.content !== 'string' || typeof write.expectedContent !== 'string'
      || write.content.length > 4_194_304 || write.expectedContent.length > 4_194_304) {
      throw new TypeError('Workspace edit file content is invalid.');
    }
    const current = decodeProjectText(await readFile(projectEntryPathIn(root, write.relPath)));
    if (current.binary || current.content !== write.expectedContent) {
      throw new Error(`File changed on disk: ${write.relPath}`);
    }
  }
  const committed: typeof normalized = [];
  try {
    for (const write of normalized) {
      await writeProjectTextFileIn(root, write.relPath, write.content, write.expectedContent);
      committed.push(write);
    }
  } catch (error) {
    for (const write of committed.reverse()) {
      await writeProjectTextFileIn(root, write.relPath, write.expectedContent, write.content)
        .catch(() => {});
    }
    throw error;
  }
}

const INVALID_ENTRY_SEGMENT = /[:*?"<>|\u0000-\u001f]/;

function explorerEntrySegments(name: string): string[] {
  const segments = String(name || '').replace(/\\/g, '/').split('/')
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
  const target = projectEntryPathIn(root, relTarget);
  if (dir) {
    await mkdir(target, { recursive: true });
    return;
  }
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, '', { encoding: 'utf8', flag: 'wx' });
}

/** Files tree: rename an entry in place (same directory). */
export async function renameProjectEntryIn(root: string, relPath: string, newName: string): Promise<void> {
  const trimmed = String(newName || '').trim();
  if (!trimmed || /[\\/:*?"<>|\u0000-\u001f]/.test(trimmed) || trimmed === '.' || trimmed === '..') {
    throw new TypeError('Entry name is invalid.');
  }
  const source = projectEntryPathIn(root, relPath);
  if (source === root) throw new Error('Cannot rename the project root.');
  await rename(source, join(dirname(source), trimmed));
}

/** Files tree: move an entry into another project folder (Explorer DnD and
 *  cut/paste). Never overwrites; a same-name target is a hard error. */
export async function moveProjectEntryIn(root: string, relPath: string, targetDirRel: string): Promise<void> {
  const source = projectEntryPathIn(root, relPath);
  if (source === root) throw new Error('Cannot move the project root.');
  const targetDir = projectEntryPathIn(root, targetDirRel);
  if (!(await stat(targetDir)).isDirectory()) throw new Error('Move target is not a folder.');
  if (targetDir === source || targetDir.startsWith(source + sep)) {
    throw new Error('Cannot move a folder into itself.');
  }
  const destination = join(targetDir, basename(source));
  if (destination === source) return;
  if (await stat(destination).then(() => true, () => false)) {
    throw new Error('An entry with that name already exists in the target folder.');
  }
  await rename(source, destination);
}

/** Files tree: copy an entry into a project folder. Collisions take the
 *  conventional paste name — "name copy", then "name copy 2", ... */
export async function copyProjectEntryIn(
  root: string,
  relPath: string,
  targetDirRel: string,
): Promise<{ name: string }> {
  const source = projectEntryPathIn(root, relPath);
  if (source === root) throw new Error('Cannot copy the project root.');
  const targetDir = projectEntryPathIn(root, targetDirRel);
  if (!(await stat(targetDir)).isDirectory()) throw new Error('Copy target is not a folder.');
  if (targetDir === source || targetDir.startsWith(source + sep)) {
    throw new Error('Cannot copy a folder into itself.');
  }
  const sourceIsDir = (await stat(source)).isDirectory();
  const exists = (candidate: string) => stat(join(targetDir, candidate)).then(() => true, () => false);
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
}
