import { clientIp } from './relay-http.mjs';
import { FeedbackError, MAX_FEEDBACK_BODY_BYTES } from './feedback.mjs';

const BODY_TIMEOUT_MS = 60_000;
const MAX_CONCURRENT_READS = 3;
let activeReads = 0;

function reply(response, status, payload, extra = {}) {
  response
    .writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra })
    .end(JSON.stringify(payload));
}

function fail(response, status, code, extra) {
  reply(response, status, { error: code }, extra);
}

function tooLarge(request, response) {
  response.once('finish', () => request.destroy());
  fail(response, 413, 'payload_too_large', { Connection: 'close' });
}

// Answers without consuming the body, then drops the connection.
function rejectUnread(request, response, status, code) {
  response.once('finish', () => request.destroy());
  fail(response, status, code, { Connection: 'close' });
}

function readBody(request, response) {
  return new Promise((resolve) => {
    let chunks = [];
    let total = 0;
    let settled = false;
    // The one settlement point: stops the timer, releases listeners and buffers.
    const settle = (finalize) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.off('data', onData);
      request.off('end', onEnd);
      const body = finalize === onEnd ? Buffer.concat(chunks) : null;
      chunks = [];
      resolve(body);
      if (finalize === onTimeout) {
        response.once('finish', () => request.destroy());
        fail(response, 408, 'request_timeout', { Connection: 'close' });
      } else if (finalize === onOversize) tooLarge(request, response);
    };
    const onTimeout = () => settle(onTimeout);
    const onEnd = () => settle(onEnd);
    const onOversize = () => settle(onOversize);
    const onGone = () => settle(onGone);
    const onData = (chunk) => {
      total += chunk.length;
      if (total > MAX_FEEDBACK_BODY_BYTES) onOversize();
      else chunks.push(chunk);
    };
    const timer = setTimeout(onTimeout, BODY_TIMEOUT_MS);
    request.on('data', onData);
    request.on('end', onEnd);
    // Stay attached for errors: an unhandled 'error' event would crash the process.
    request.on('error', onGone);
    request.on('close', onGone);
  });
}

/** POST /feedback. `feedback` is the service, or null when it failed to build. */
export async function handleFeedbackRequest(feedback, request, response) {
  if (request.method !== 'POST') {
    fail(response, 405, 'method_not_allowed', { Allow: 'POST' });
    return;
  }
  let slotHeld = false;
  try {
    if (!feedback?.configured) {
      rejectUnread(request, response, 503, 'feedback_unavailable');
      return;
    }
    if (!/^application\/json\s*(;|$)/i.test(String(request.headers['content-type'] || '').trim())) {
      rejectUnread(request, response, 415, 'unsupported_media_type');
      return;
    }
    feedback.checkRate(clientIp(request));
    const declared = Number(request.headers['content-length']);
    if (declared > MAX_FEEDBACK_BODY_BYTES) {
      tooLarge(request, response);
      return;
    }
    // Bound memory: each body can be ~8 MB and is held about twice.
    if (activeReads >= MAX_CONCURRENT_READS) {
      rejectUnread(request, response, 503, 'feedback_busy');
      return;
    }
    activeReads++;
    slotHeld = true;
    const raw = await readBody(request, response);
    if (raw === null) return;
    let body;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new FeedbackError(400, 'invalid_feedback');
    }
    reply(response, 202, await feedback.submit(body));
  } catch (error) {
    if (!(error instanceof FeedbackError)) {
      console.error('[relay] feedback request failed:', error?.code || 'error');
      fail(response, 503, 'feedback_unavailable');
      return;
    }
    fail(response, error.status, error.code);
  } finally {
    if (slotHeld) activeReads--;
  }
}
