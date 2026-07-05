import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { dirname } from "path";
import { writeJsonAtomicSync } from "../../shared/atomic-file.mjs";
function ensureDir(dirPath) {
  mkdirSync(dirPath, { recursive: true });
}
function removeFileIfExists(filePath) {
  try {
    unlinkSync(filePath);
  } catch (err) {
    if (err.code !== "ENOENT") {
      throw err;
    }
  }
}
function readJsonFile(filePath, fallback) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}
function readJsonFileStrict(filePath) {
  const raw = readFileSync(filePath, "utf8");
  return JSON.parse(raw);
}
function writeTextFile(filePath, value) {
  ensureDir(dirname(filePath));
  writeFileSync(filePath, value);
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
  ensure() {
    writeJsonFile(this.filePath, this.read());
  }
  update(mutator) {
    let draft;
    try {
      draft = readJsonFileStrict(this.filePath);
    } catch (err) {
      process.stderr.write(`[state-file] REFUSING update: parse error for ${this.filePath}: ${err.message}\n`);
      throw err;
    }
    mutator(draft);
    return this.write(draft);
  }
}
export {
  JsonStateFile,
  ensureDir,
  readJsonFile,
  removeFileIfExists,
  writeJsonFile,
  writeTextFile
};
