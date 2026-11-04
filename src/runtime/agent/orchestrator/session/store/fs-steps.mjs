/**
 * Store reads written once, as generators that yield the filesystem
 * operations they need (`['stat', path, options]`, `['readFile', path,
 * encoding]`, `['readdir', path]`). runFsStepsSync performs them with blocking
 * calls (worker threads, short CLI paths); runFsStepsAsync awaits the
 * promise-based calls, so on the daemon loop no read blocks it. Both runners
 * make the same decisions from the same answers. A failed operation is thrown
 * back into the generator, exactly like the call it stands for.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';

const SYNC_OPS = {
  stat: (path, options) => statSync(path, options),
  readFile: (path, encoding) => readFileSync(path, encoding),
  readdir: (path) => readdirSync(path),
};

const ASYNC_OPS = {
  stat: (path, options) => stat(path, options),
  readFile: (path, encoding) => readFile(path, encoding),
  readdir: (path) => readdir(path),
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
