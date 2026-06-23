import * as nodeBuffer from 'node:buffer';
import { readFileSync } from 'node:fs';
import { readFile as readFileAsync } from 'node:fs/promises';
import { decodeRawBufferForSnapshotCheck } from './builtin/snapshot-helpers.mjs';

function keyForPath(fullPath) {
  const text = String(fullPath || '');
  return process.platform === 'win32' ? text.toLowerCase() : text;
}

export function isValidUtf8Buffer(buf) {
  if (typeof nodeBuffer.isUtf8 === 'function') return nodeBuffer.isUtf8(buf);
  if (typeof Buffer.isUtf8 === 'function') return Buffer.isUtf8(buf);
  return Buffer.from(buf.toString('utf-8'), 'utf-8').equals(buf);
}

export function createMutationContentCache() {
  const entries = new Map();

  function getOrCreate(fullPath) {
    const key = keyForPath(fullPath);
    let entry = entries.get(key);
    if (!entry) {
      entry = { fullPath, rawBuf: null, content: null };
      entries.set(key, entry);
    }
    return entry;
  }

  function seedBuffer(fullPath, rawBuf) {
    const entry = getOrCreate(fullPath);
    entry.rawBuf = rawBuf;
    entry.content = null;
    return entry;
  }

  function readBufferSync(fullPath) {
    const entry = getOrCreate(fullPath);
    if (!Buffer.isBuffer(entry.rawBuf)) entry.rawBuf = readFileSync(fullPath);
    return entry.rawBuf;
  }

  async function readBuffer(fullPath) {
    const entry = getOrCreate(fullPath);
    if (!Buffer.isBuffer(entry.rawBuf)) entry.rawBuf = await readFileAsync(fullPath);
    return entry.rawBuf;
  }

  function readTextSync(fullPath) {
    const entry = getOrCreate(fullPath);
    if (typeof entry.content !== 'string') {
      entry.content = decodeRawBufferForSnapshotCheck(readBufferSync(fullPath));
    }
    return entry.content;
  }

  function getEntry(fullPath) {
    return entries.get(keyForPath(fullPath)) || null;
  }

  function clear(fullPath = null) {
    if (fullPath) entries.delete(keyForPath(fullPath));
    else entries.clear();
  }

  return { seedBuffer, readBuffer, readBufferSync, readTextSync, getEntry, clear };
}
