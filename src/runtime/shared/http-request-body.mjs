import { finished } from 'node:stream/promises';

// Read bounded JSON while accounting for an optional process-wide byte budget.
// The caller chooses whether a rejected body is drained or its socket closed.
export function readJsonRequestBody(req, {
  maxBytes,
  reserve,
  release,
  tooLargeMessage = `request body exceeds the ${maxBytes} byte limit`,
  destroyOnLimit = false,
} = {}) {
  return new Promise((resolve, reject) => {
    let chunks = [];
    let total = 0;
    let reserved = 0;
    let settled = false;

    function settle(error, value) {
      if (settled) return;
      settled = true;
      chunks = [];
      req.off('data', onData);
      req.off('end', onEnd);
      if (reserved > 0) {
        const bytes = reserved;
        reserved = 0;
        try { release?.(bytes); } catch (releaseError) { error ??= releaseError; }
      }
      if (error) reject(error);
      else resolve(value);
    }

    function rejectLimit(message, statusCode) {
      const error = new Error(message);
      error.statusCode = statusCode;
      settle(error);
      if (destroyOnLimit) {
        try { req.destroy(); } catch {}
      } else {
        req.resume();
      }
    }

    function onData(value) {
      if (settled) return;
      try {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        total += chunk.length;
        if (total > maxBytes) {
          rejectLimit(tooLargeMessage, 413);
          return;
        }
        if (reserve && !reserve(chunk.length)) {
          rejectLimit('daemon request memory budget is busy', 503);
          return;
        }
        reserved += chunk.length;
        chunks.push(chunk);
      } catch (error) {
        settle(error);
      }
    }

    function onEnd() {
      if (settled) return;
      try {
        const raw = Buffer.concat(chunks, total).toString('utf8').trim();
        settle(null, raw ? JSON.parse(raw) : {});
      } catch (error) {
        const invalid = new Error(`invalid JSON body: ${error.message}`);
        invalid.statusCode = 400;
        settle(invalid);
      }
    }

    // Node owns terminal-event ordering, including streams already marked
    // destroyed whose error/close events have not been delivered yet.
    void finished(req, { readable: true, writable: false, cleanup: true }).then(
      () => { if (!settled) onEnd(); },
      (error) => settle(error),
    );
    if (req.destroyed || req.readableEnded) {
      settle(req.errored || Object.assign(
        new Error('request body closed before end'),
        { code: 'ERR_STREAM_PREMATURE_CLOSE' },
      ));
      return;
    }
    const contentLength = Number(req.headers?.['content-length']);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      rejectLimit(tooLargeMessage, 413);
      return;
    }
    req.on('data', onData);
    req.on('end', onEnd);
  });
}
