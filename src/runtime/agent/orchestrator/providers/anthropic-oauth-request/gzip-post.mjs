// The /v1/messages POST with request-body gzip (probe-verified 2026-08-04:
// /v1/messages returns 200 for Content-Encoding: gzip, 400 for zstd). Large turn
// bodies (system prompt + history, typically 50-100KB+) compress ~5-10x,
// trimming upload time off every call's header wait. Env kill-switch
// (MIXDOG_ANTHROPIC_REQ_GZIP=0) plus a process-wide latch flipped on the first
// 400 seen on a compressed request; small bodies skip compression since below
// ~8KB the CPU + header cost outweighs the upload saving.
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import { getLlmDispatcher } from '../../../../shared/llm/http-agent.mjs';
import { claudeCliUserAgent } from '../anthropic-oauth-client-version.mjs';

const API_URL = 'https://api.anthropic.com/v1/messages';
export const ANTHROPIC_VERSION = '2023-06-01';

const ANTHROPIC_REQ_GZIP_MIN_BYTES = 8 * 1024;
let gzipLatchedOff = false;
const gzipDisabled = () => gzipLatchedOff || process.env.MIXDOG_ANTHROPIC_REQ_GZIP === '0';
// Compress on the libuv threadpool so large turn bodies never block the main thread.
const gzipAsync = promisify(gzip);

export async function postMessages({ accessToken, requestBody, betaHeaders, signal }) {
  const rawBody = Buffer.from(JSON.stringify(requestBody));
  const useGzip = !gzipDisabled() && rawBody.length >= ANTHROPIC_REQ_GZIP_MIN_BYTES;
  const sendAttempt = async (gz) =>
    fetch(API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'anthropic-version': ANTHROPIC_VERSION,
        'anthropic-beta': betaHeaders,
        'anthropic-dangerous-direct-browser-access': 'true',
        'user-agent': claudeCliUserAgent(),
        'x-app': 'cli',
        'Content-Type': 'application/json',
        ...(gz ? { 'Content-Encoding': 'gzip' } : {}),
      },
      body: gz ? await gzipAsync(rawBody) : rawBody,
      signal,
      dispatcher: getLlmDispatcher(),
    });
  let response = await sendAttempt(useGzip);
  if (useGzip && response.status === 400) {
    // Latch OFF process-wide and retry this attempt uncompressed, so a
    // server-side behavior change can never wedge the session.
    gzipLatchedOff = true;
    try {
      await response.arrayBuffer();
    } catch {
      /* drain best-effort */
    }
    response = await sendAttempt(false);
  }
  return response;
}
