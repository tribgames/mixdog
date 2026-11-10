// Worker side of mask-pool.mjs: masks batches of source texts off the daemon
// main thread with the same _maskNonCodeText the synchronous path runs.
import { parentPort } from 'node:worker_threads';
import { _maskNonCodeText } from './text-mask.mjs';

parentPort?.on('message', ({ id, texts, langs }) => {
  try {
    parentPort.postMessage({ id, masked: texts.map((text, i) => _maskNonCodeText(text, langs[i])) });
  } catch (error) {
    parentPort.postMessage({ id, error: String(error?.message || error) });
  }
});
