import { createRequire } from 'node:module';
import { parentPort, workerData } from 'node:worker_threads';

function errorText(error) {
  return error instanceof Error ? error.message : String(error || 'unknown native addon error');
}

if (!parentPort) throw new Error('mixdog-token worker requires parentPort');

let countTokens;
try {
  const addon = createRequire(import.meta.url)(String(workerData?.addonPath || ''));
  if (typeof addon?.countTokens !== 'function') {
    throw new TypeError('mixdog-token addon does not export countTokens');
  }
  countTokens = addon.countTokens;
  countTokens('mixdog tokenizer warmup — 워밍업 텍스트 0123456789');
  parentPort.postMessage({ type: 'ready' });
} catch (error) {
  parentPort.postMessage({ type: 'fatal', error: errorText(error) });
}

parentPort.on('message', (message) => {
  if (!countTokens || message?.type !== 'count') return;
  const id = Number(message.id);
  try {
    parentPort.postMessage({
      type: 'result',
      id,
      count: countTokens(String(message.text ?? '')),
    });
  } catch (error) {
    parentPort.postMessage({ type: 'result', id, count: null, error: errorText(error) });
  }
});
