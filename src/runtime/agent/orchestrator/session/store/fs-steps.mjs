/**
 * Store reads written once, as generators that yield the filesystem
 * operations they need (`['stat', path, options]`, `['readFile', path,
 * encoding]`, `['readdir', path]`, and the session record seam's
 * `['sessionRecord', args]` / `['sessionRecordStamp', paths]`). runFsStepsSync performs them with blocking
 * calls (worker threads, short CLI paths); runFsStepsAsync awaits the
 * promise-based calls, so on the daemon loop no read blocks it. Both runners
 * make the same decisions from the same answers. A failed operation is thrown
 * back into the generator, exactly like the call it stands for.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import {
  resolveSessionRecord,
  resolveSessionRecordSync,
  sessionRecordStamp,
  sessionRecordStampSync,
} from './session-log-reader.mjs';

// `sessionRecord` / `sessionRecordStamp` are the session-log seam's resolve
// and stamp (session-log-reader.mjs), so a session record read is one step.
const SYNC_OPS = {
  stat: (path, options) => statSync(path, options),
  readFile: (path, encoding) => readFileSync(path, encoding),
  readdir: (path) => readdirSync(path),
  sessionRecord: (args) => resolveSessionRecordSync(args),
  sessionRecordStamp: (paths) => sessionRecordStampSync(paths),
};

const ASYNC_OPS = {
  stat: (path, options) => stat(path, options),
  readFile: (path, encoding) => readFile(path, encoding),
  readdir: (path) => readdir(path),
  sessionRecord: (args) => resolveSessionRecord(args),
  sessionRecordStamp: (paths) => sessionRecordStamp(paths),
};

export function runFsStepsSync(steps) {
  let step = steps.next();
  while (!step.done) {
    const [op, ...args] = step.value;
    let value;
    try {
      value = SYNC_OPS[op](...args);
    } catch (error) {
      step = steps.throw(error);
      continue;
    }
    step = steps.next(value);
  }
  return step.value;
}

export async function runFsStepsAsync(steps) {
  let step = steps.next();
  while (!step.done) {
    const [op, ...args] = step.value;
    let value;
    try {
      value = await ASYNC_OPS[op](...args);
    } catch (error) {
      step = steps.throw(error);
      continue;
    }
    step = steps.next(value);
  }
  return step.value;
}
