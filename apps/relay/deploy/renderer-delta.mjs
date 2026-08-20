import { createHash } from 'node:crypto';
import {
  cp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

function parseArgs(argv) {
  return Object.fromEntries(argv.map((entry) => {
    const match = /^--([^=]+)=(.*)$/s.exec(entry);
    return match ? [match[1], match[2]] : [entry.replace(/^--/, ''), true];
  }));
}

function safeRelativePath(value) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.startsWith('/')
    || value.includes('\\')
    || value.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error(`Unsafe renderer manifest path: ${JSON.stringify(value)}`);
  }
  return value;
}

async function pathType(path) {
  try {
    const metadata = await stat(path);
    return metadata.isDirectory() ? 'directory' : metadata.isFile() ? 'file' : 'other';
  } catch (error) {
    if (error?.code === 'ENOENT') return 'missing';
    throw error;
  }
}

async function walk(root, dir = root, files = []) {
  if (await pathType(dir) === 'missing') return files;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Renderer tree contains a symbolic link: ${path}`);
    if (entry.isDirectory()) await walk(root, path, files);
    else if (entry.isFile()) files.push(path);
    else throw new Error(`Renderer tree contains an unsupported entry: ${path}`);
  }
  return files;
}

async function hashFile(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

function treeHash(files) {
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(file.path);
    hash.update('\0');
    hash.update(String(file.size));
    hash.update('\0');
    hash.update(file.sha256);
    hash.update('\0');
  }
  return hash.digest('hex');
}

export function validateRendererManifest(value) {
  if (!value || value.schemaVersion !== 1 || !Array.isArray(value.files)) {
    throw new Error('Renderer manifest is missing or incompatible.');
  }
  const seen = new Set();
  const files = value.files.map((entry) => {
    const path = safeRelativePath(entry?.path);
    if (seen.has(path)) throw new Error(`Duplicate renderer manifest path: ${path}`);
    seen.add(path);
    if (!Number.isSafeInteger(entry.size) || entry.size < 0) {
      throw new Error(`Invalid renderer manifest size: ${path}`);
    }
    if (!/^[a-f0-9]{64}$/.test(entry.sha256 || '')) {
      throw new Error(`Invalid renderer manifest hash: ${path}`);
    }
    return { path, size: entry.size, sha256: entry.sha256 };
  });
  files.sort((left, right) => left.path.localeCompare(right.path));
  const expectedTreeHash = treeHash(files);
  if (value.treeHash !== expectedTreeHash) {
    throw new Error('Renderer manifest tree hash does not match its file list.');
  }
  return { schemaVersion: 1, treeHash: expectedTreeHash, files };
}

export async function buildRendererManifest(root) {
  const resolvedRoot = resolve(root);
  const paths = await walk(resolvedRoot);
  const files = [];
  paths.sort((left, right) => left.localeCompare(right));
  for (const path of paths) {
    const metadata = await stat(path);
    files.push({
      path: safeRelativePath(relative(resolvedRoot, path).split(sep).join('/')),
      size: metadata.size,
      sha256: await hashFile(path),
    });
  }
  return {
    schemaVersion: 1,
    treeHash: treeHash(files),
    files,
  };
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, path);
}

async function readManifest(path) {
  return validateRendererManifest(JSON.parse(await readFile(path, 'utf8')));
}

export async function createRendererDelta({
  root,
  baseManifest,
  deltaDir,
  manifestPath,
}) {
  const current = await buildRendererManifest(root);
  const base = baseManifest ? validateRendererManifest(baseManifest) : {
    schemaVersion: 1,
    treeHash: treeHash([]),
    files: [],
  };
  const baseFiles = new Map(base.files.map((file) => [file.path, file]));
  await rm(deltaDir, { recursive: true, force: true });
  await mkdir(deltaDir, { recursive: true });
  let changedBytes = 0;
  let changedFiles = 0;
  for (const file of current.files) {
    const previous = baseFiles.get(file.path);
    if (previous?.size === file.size && previous.sha256 === file.sha256) continue;
    const source = join(resolve(root), ...file.path.split('/'));
    const destination = join(resolve(deltaDir), ...file.path.split('/'));
    await mkdir(dirname(destination), { recursive: true });
    await cp(source, destination);
    changedBytes += file.size;
    changedFiles += 1;
  }
  await writeJsonAtomic(manifestPath, current);
  return {
    totalFiles: current.files.length,
    totalBytes: current.files.reduce((sum, file) => sum + file.size, 0),
    changedFiles,
    changedBytes,
    removedFiles: base.files.filter((file) => !current.files.some(
      (candidate) => candidate.path === file.path,
    )).length,
    treeHash: current.treeHash,
  };
}

export async function applyRendererDelta({
  baseDir,
  deltaDir,
  manifest,
  outputDir,
}) {
  const target = validateRendererManifest(manifest);
  const targetFiles = new Map(target.files.map((file) => [file.path, file]));
  await rm(outputDir, { recursive: true, force: true });
  if (await pathType(baseDir) === 'directory') {
    await cp(baseDir, outputDir, { recursive: true });
  } else {
    await mkdir(outputDir, { recursive: true });
  }

  for (const path of await walk(resolve(outputDir))) {
    const relativePath = safeRelativePath(relative(resolve(outputDir), path).split(sep).join('/'));
    if (!targetFiles.has(relativePath)) await rm(path, { force: true });
  }

  for (const path of await walk(resolve(deltaDir))) {
    const relativePath = safeRelativePath(relative(resolve(deltaDir), path).split(sep).join('/'));
    const expected = targetFiles.get(relativePath);
    if (!expected) throw new Error(`Renderer delta contains an unlisted file: ${relativePath}`);
    const metadata = await stat(path);
    if (metadata.size !== expected.size || await hashFile(path) !== expected.sha256) {
      throw new Error(`Renderer delta file failed verification: ${relativePath}`);
    }
    const destination = join(resolve(outputDir), ...relativePath.split('/'));
    await mkdir(dirname(destination), { recursive: true });
    await cp(path, destination);
  }

  const applied = await buildRendererManifest(outputDir);
  if (applied.treeHash !== target.treeHash) {
    throw new Error(
      `Renderer reconstruction failed verification: expected ${target.treeHash}, got ${applied.treeHash}`,
    );
  }
  return {
    files: applied.files.length,
    bytes: applied.files.reduce((sum, file) => sum + file.size, 0),
    treeHash: applied.treeHash,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.action === 'manifest') {
    process.stdout.write(`${JSON.stringify(await buildRendererManifest(resolve(args.root)))}\n`);
    return;
  }
  if (args.action === 'create') {
    const baseManifest = args.base ? await readManifest(resolve(args.base)) : null;
    const result = await createRendererDelta({
      root: resolve(args.root),
      baseManifest,
      deltaDir: resolve(args.delta),
      manifestPath: resolve(args.manifest),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (args.action === 'apply') {
    const result = await applyRendererDelta({
      baseDir: resolve(args.base),
      deltaDir: resolve(args.delta),
      manifest: await readManifest(resolve(args.manifest)),
      outputDir: resolve(args.output),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  throw new Error(`Unknown renderer-delta action: ${args.action || '(missing)'}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  await main();
}
