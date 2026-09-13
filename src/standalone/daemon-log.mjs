import path from 'node:path';
import * as fs from 'node:fs/promises';
import { inspect } from 'node:util';
import { PLUGIN_LOG_MAX_BYTES, PLUGIN_LOG_KEEP_BYTES } from '../lib/mixdog-debug.cjs';

const LOG_LINE_MAX_CHARS = 16_384;
const LOG_QUEUE_MAX_BYTES = 512 * 1024;

export function createDaemonLog({
  logPath,
  fileSystem = fs,
  stderr = process.stderr,
  stdout = process.stdout,
  consoleTarget = console,
}) {
  let fileLogging = false;
  let queue = [];
  let queueBytes = 0;
  let dropped = 0;
  let flushTimer = null;
  let writer = null;
  let fileBytes = null;

  function boundedText(value) {
    const text = String(value ?? '');
    if (text.length <= LOG_LINE_MAX_CHARS) return text;
    return `${text.slice(0, LOG_LINE_MAX_CHARS)}… [truncated ${text.length - LOG_LINE_MAX_CHARS} chars]`;
  }

  async function rotateIfNeeded(incomingBytes) {
    if (fileBytes === null) {
      try { fileBytes = (await fileSystem.stat(logPath)).size; }
      catch { fileBytes = 0; }
    }
    if (fileBytes + incomingBytes <= PLUGIN_LOG_MAX_BYTES) return;
    const keep = Math.min(fileBytes, PLUGIN_LOG_KEEP_BYTES);
    const tail = Buffer.allocUnsafe(keep);
    const handle = await fileSystem.open(logPath, 'r');
    try {
      const { bytesRead } = await handle.read(tail, 0, keep, Math.max(0, fileBytes - keep));
      await fileSystem.writeFile(logPath, tail.subarray(0, bytesRead));
      fileBytes = bytesRead;
    } finally {
      await handle.close().catch(() => {});
    }
  }

  function takeBatch() {
    if (queue.length === 0 && dropped === 0) return '';
    const omitted = dropped;
    const rows = queue;
    queue = [];
    queueBytes = 0;
    dropped = 0;
    if (omitted > 0) {
      rows.unshift(`[${new Date().toISOString()}] [daemon] dropped ${omitted} log line(s) under backpressure\n`);
    }
    return rows.join('');
  }

  function clearFlushTimer() {
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = null;
  }

  function queueFlush() {
    // Never move another batch into a promise chain while the disk is busy:
    // pending bytes must stay in the one bounded queue until they can be written.
    if (flushTimer || writer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flush();
    }, 10);
    flushTimer.unref?.();
  }

  function beginDrain() {
    if (writer) return writer;
    const promise = (async () => {
      while (queue.length > 0 || dropped > 0) {
        const batch = takeBatch();
        try {
          await fileSystem.mkdir(path.dirname(logPath), { recursive: true });
          const bytes = Buffer.byteLength(batch);
          await rotateIfNeeded(bytes);
          await fileSystem.appendFile(logPath, batch, 'utf8');
          fileBytes = (fileBytes || 0) + bytes;
        } catch {
          // A failed append or rotation may already have changed the file.
          // Re-read its size before admitting the next best-effort batch.
          fileBytes = null;
        }
      }
    })().finally(() => {
      if (writer === promise) writer = null;
      if (queue.length > 0 || dropped > 0) queueFlush();
    });
    writer = promise;
    return promise;
  }

  function append(text) {
    const line = `[${new Date().toISOString()}] ${boundedText(text)}\n`;
    const bytes = Buffer.byteLength(line);
    if (bytes > LOG_QUEUE_MAX_BYTES || queueBytes + bytes > LOG_QUEUE_MAX_BYTES) {
      dropped += 1;
    } else {
      queue.push(line);
      queueBytes += bytes;
    }
    queueFlush();
  }

  async function flush() {
    clearFlushTimer();
    while (writer || queue.length > 0 || dropped > 0) {
      await beginDrain();
      clearFlushTimer();
    }
  }

  function log(line) {
    const text = `[daemon] ${line}`;
    // The spawner mirrors stderr before ready; after ready the daemon owns the
    // file. Each line has exactly one sink across that handoff.
    if (!fileLogging) {
      try { stderr.write(`${text}\n`); } catch {}
      return;
    }
    append(text);
  }

  function installRedirect() {
    if (process.env.MIXDOG_DAEMON_ALLOW_STDERR === '1') return;
    const file = (chunk) => {
      const text = String(chunk ?? '').trimEnd();
      if (text) append(text);
    };
    for (const stream of [stderr, stdout]) {
      stream.write = (chunk, encoding, callback) => {
        const done = typeof encoding === 'function' ? encoding : callback;
        file(chunk);
        if (typeof done === 'function') { try { done(); } catch {} }
        return true;
      };
    }
    for (const method of ['log', 'info', 'warn', 'error', 'debug', 'trace']) {
      consoleTarget[method] = (...args) => file(`[console.${method}] ${args.map((value) =>
        typeof value === 'string'
          ? boundedText(value)
          : boundedText(inspect(value, {
            depth: 4,
            maxArrayLength: 50,
            maxStringLength: 4_096,
            breakLength: Infinity,
            compact: true,
          }))).join(' ')}`);
    }
  }

  return {
    log,
    flush,
    installRedirect,
    enableFileLogging: () => { fileLogging = true; },
  };
}
