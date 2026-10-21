// The OCR engine's own thread. Starting the engine includes the first-use
// download of each language's data and gives no handle until it finishes, so
// it runs here, where ending this thread ends the engine and the download with
// it (ocr-engine.mjs).
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { parentPort, workerData } from 'node:worker_threads';

const require = createRequire(import.meta.url);
const { languages, cachePath, langPath } = workerData;

let engine = null;
try {
  await mkdir(cachePath, { recursive: true });
  const tesseract = require('tesseract.js');
  engine = await tesseract.createWorker(languages, tesseract.OEM.LSTM_ONLY, {
    cachePath,
    gzip: true,
    ...(langPath ? { langPath } : {}),
  });
} catch (error) {
  parentPort.postMessage({ startError: String(error?.message || error) });
}

if (engine) {
  // One page at a time, in arrival order: the engine itself is serial.
  parentPort.on('message', async ({ id, image, output }) => {
    try {
      const input = typeof image === 'string' ? image : Buffer.from(image.buffer, image.byteOffset, image.byteLength);
      const recognized = await engine.recognize(input, {}, output || { text: true });
      parentPort.postMessage({ id, data: recognized.data });
    } catch (error) {
      parentPort.postMessage({ id, error: String(error?.message || error) });
    }
  });
  parentPort.postMessage({ ready: true });
}
