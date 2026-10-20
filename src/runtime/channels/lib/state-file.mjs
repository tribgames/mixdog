import { mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { readJsonStateSync, updateJsonAtomicSync, writeJsonAtomicSync } from '../../shared/atomic-file.mjs';
function ensureDir(dirPath) {
  mkdirSync(dirPath, { recursive: true });
}
function removeFileIfExists(filePath) {
  try {
    unlinkSync(filePath);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      throw err;
    }
  }
}
function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}
function writeJsonFile(filePath, value) {
  writeJsonAtomicSync(filePath, value, { compact: true, lock: true, fsync: false, fsyncDir: false });
}
class JsonStateFile {
  constructor(filePath, fallback) {
    this.filePath = filePath;
    this.fallback = fallback;
  }
  read() {
    return readJsonFile(this.filePath, this.fallback);
  }
  write(value) {
    writeJsonFile(this.filePath, value);
    return value;
  }
  // A damaged file (empty, NUL-filled after a crash) is kept aside as
  // <file>.corrupt-<ts> and the file restarts from the fallback; it is never
  // overwritten in place and never blocks an update. That recovery is why the
  // writes below can skip fsync.
  ensure() {
    writeJsonFile(this.filePath, readJsonStateSync(this.filePath, { fallback: this.fallback }));
  }
  update(mutator) {
    return updateJsonAtomicSync(
      this.filePath,
      (current) => {
        const draft = current ?? structuredClone(this.fallback);
        mutator(draft);
        return draft;
      },
      { compact: true, fsync: false, fsyncDir: false }
    );
  }
}
export { JsonStateFile, ensureDir, readJsonFile, removeFileIfExists, writeJsonFile };
