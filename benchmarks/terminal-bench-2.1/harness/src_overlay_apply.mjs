#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const NOFOLLOW = fs.constants.O_NOFOLLOW || 0;

if (process.env.MIXDOG_OVERLAY_TEST_UMASK) {
  if (!/^[0-7]{1,4}$/.test(process.env.MIXDOG_OVERLAY_TEST_UMASK)) {
    throw new Error('invalid MIXDOG_OVERLAY_TEST_UMASK');
  }
  process.umask(Number.parseInt(process.env.MIXDOG_OVERLAY_TEST_UMASK, 8));
}

const fail = (message) => { throw new Error(message); };
const exists = (target) => {
  try { fs.lstatSync(target); return true; }
  catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
};
const lstat = (target, description) => {
  const info = fs.lstatSync(target);
  if (info.isSymbolicLink()) fail(`${description} is a symlink: ${target}`);
  return info;
};
const validRelativePath = (value) => typeof value === 'string' && value.length > 0 &&
  !value.includes('\\') && !value.startsWith('/') &&
  value.split('/').every((part) => part && part !== '.' && part !== '..');
const hashBytes = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const modeMatches = (actual, expected) => process.platform === 'win32' ||
  (actual & 0o777) === expected;
function createDirectory(target, mode, description) {
  fs.mkdirSync(target, { mode: 0o700 });
  fs.chmodSync(target, mode);
  const info = lstat(target, description);
  if (!info.isDirectory() || !modeMatches(info.mode, mode)) {
    fail(`${description} mode mismatch: ${target}`);
  }
  fs.accessSync(target, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
}

function readRegular(target, description) {
  const before = lstat(target, description);
  if (!before.isFile()) fail(`${description} is not a regular file: ${target}`);
  const fd = fs.openSync(target, fs.constants.O_RDONLY | NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino ||
        opened.size !== before.size) {
      fail(`${description} changed while opening: ${target}`);
    }
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count === 0) fail(`${description} truncated while reading: ${target}`);
      offset += count;
    }
    const after = fs.fstatSync(fd);
    if (after.dev !== opened.dev || after.ino !== opened.ino ||
        after.size !== opened.size || after.mtimeMs !== opened.mtimeMs ||
        after.ctimeMs !== opened.ctimeMs) {
      fail(`${description} changed while reading: ${target}`);
    }
    return bytes;
  } finally {
    fs.closeSync(fd);
  }
}

function loadAndVerifyManifest(staging) {
  const document = JSON.parse(
    readRegular(path.join(staging, 'manifest.json'), 'overlay manifest').toString('utf8'),
  );
  if (!document || Object.keys(document).sort().join(',') !== 'files,schemaVersion' ||
      document.schemaVersion !== 2 || !Array.isArray(document.files)) {
    fail('invalid src overlay manifest');
  }
  const paths = new Set();
  let previousPath = null;
  for (let index = 0; index < document.files.length; index += 1) {
    const entry = document.files[index];
    if (!entry || Object.keys(entry).sort().join(',') !==
        'index,mode,path,sha256,size' || entry.index !== index ||
        !validRelativePath(entry.path) || ![0o644, 0o755].includes(entry.mode) ||
        !Number.isSafeInteger(entry.size) || entry.size < 0 ||
        !/^[0-9a-f]{64}$/.test(entry.sha256) || paths.has(entry.path) ||
        (previousPath !== null &&
          Buffer.compare(Buffer.from(previousPath, 'utf8'), Buffer.from(entry.path, 'utf8')) >= 0)) {
      fail('invalid src overlay manifest entry');
    }
    paths.add(entry.path);
    previousPath = entry.path;
  }
  const filesRoot = path.join(staging, 'files');
  const actual = new Set();
  function walk(directory, prefix = '') {
    const directoryInfo = lstat(directory, 'overlay staging directory');
    if (!directoryInfo.isDirectory()) fail(`overlay staging non-directory: ${prefix}`);
    for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${item.name}` : item.name;
      const full = path.join(directory, item.name);
      const info = lstat(full, 'overlay staging entry');
      if (info.isDirectory()) walk(full, relative);
      else if (info.isFile()) actual.add(relative);
      else fail(`overlay staging non-file: ${relative}`);
    }
  }
  walk(filesRoot);
  if (actual.size !== paths.size ||
      [...paths].some((relative) => !actual.has(relative))) {
    fail(`src overlay path/count mismatch: ${actual.size}/${paths.size}`);
  }
  for (const entry of document.files) {
    const bytes = readRegular(
      path.join(filesRoot, ...entry.path.split('/')),
      'overlay staging file',
    );
    if (bytes.length !== entry.size || hashBytes(bytes) !== entry.sha256) {
      fail(`src overlay content mismatch: ${entry.path}`);
    }
  }
  return document;
}

function copyFresh(source, destination, mode, description) {
  const bytes = readRegular(source, description);
  const fd = fs.openSync(
    destination,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW,
    0o600,
  );
  try {
    let offset = 0;
    while (offset < bytes.length) {
      offset += fs.writeSync(fd, bytes, offset, bytes.length - offset, offset);
    }
    fs.fchmodSync(fd, mode);
  } finally {
    fs.closeSync(fd);
  }
  return bytes;
}

function safeTargetParent(src, parts) {
  let current = src;
  const rootInfo = lstat(current, 'package src');
  if (!rootInfo.isDirectory()) fail('package src is not a directory');
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    if (exists(current)) {
      const info = lstat(current, 'overlay target ancestor');
      if (!info.isDirectory()) fail(`unsafe overlay target ancestor: ${current}`);
    } else {
      createDirectory(current, 0o755, 'created overlay target ancestor');
    }
  }
  return current;
}

function applyEntries(staging, src, document) {
  for (const entry of document.files) {
    const parts = entry.path.split('/');
    const parent = safeTargetParent(src, parts);
    const destination = path.join(parent, parts.at(-1));
    if (exists(destination)) {
      const existing = lstat(destination, 'overlay destination');
      if (!existing.isFile()) fail(`unsafe overlay destination: ${entry.path}`);
      fs.unlinkSync(destination);
    }
    const source = path.join(staging, 'files', ...parts);
    const bytes = copyFresh(source, destination, entry.mode, 'overlay source');
    const target = lstat(destination, 'overlay target');
    if (!target.isFile() || target.nlink !== 1 ||
        !modeMatches(target.mode, entry.mode) || target.size !== entry.size ||
        bytes.length !== entry.size || hashBytes(bytes) !== entry.sha256 ||
        hashBytes(readRegular(destination, 'overlay target verification')) !== entry.sha256) {
      fail(`overlay target verification failed: ${entry.path}`);
    }
  }
}

export function applyOverlay({ staging, src }) {
  // Verify the complete isolated upload before touching any package target.
  const document = loadAndVerifyManifest(staging);
  applyEntries(staging, src, document);
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--staging') options.staging = argv[++index];
    else if (argv[index] === '--src') options.src = argv[++index];
    else fail(`unknown argument: ${argv[index]}`);
  }
  if (!options.src || !options.staging) {
    fail('usage: src_overlay_apply.mjs --staging PATH --src PATH');
  }
  options.src = path.resolve(options.src);
  options.staging = path.resolve(options.staging);
  return options;
}

if (path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    applyOverlay(parseArgs(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`src-overlay-apply: ${error?.stack || error}\n`);
    process.exit(1);
  }
}
