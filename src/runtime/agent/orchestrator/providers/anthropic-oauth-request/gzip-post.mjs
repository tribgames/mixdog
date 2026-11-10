// The /v1/messages POST with request-body gzip (probe-verified 2026-08-04:
// /v1/messages returns 200 for Content-Encoding: gzip, 400 for zstd). Large turn
// bodies (system prompt + history, typically 50-100KB+) compress ~5-10x,
// trimming upload time off every call's header wait. Env kill-switch
// (MIXDOG_ANTHROPIC_REQ_GZIP=0); the gzip policy (8KB floor, fail-open,
// 400/415 plain resend + latch-on-success) lives in lib/request-compression.mjs.
import { getLlmDispatcher } from '../../../../shared/llm/http-agent.mjs';
import { claudeCliUserAgent } from '../anthropic-oauth-client-version.mjs';
import { ANTHROPIC_VERSION } from '../lib/anthropic-models.mjs';
import { sendGzipCompressed } from '../lib/request-compression.mjs';

const API_URL = 'https://api.anthropic.com/v1/messages';
export { ANTHROPIC_VERSION };

// `plain`: exactly one uncompressed POST (a cache warm), so no compression
// rejection resend can follow.
export async function postMessages({ accessToken, requestBody, betaHeaders, signal, compress, plain = false }) {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'anthropic-version': ANTHROPIC_VERSION,
    'anthropic-beta': betaHeaders,
    'anthropic-dangerous-direct-browser-access': 'true',
    'user-agent': claudeCliUserAgent(),
    'x-app': 'cli',
    'Content-Type': 'application/json',
  };
  const raw = Buffer.from(JSON.stringify(requestBody));
  const send = (body, sendHeaders) =>
    fetch(API_URL, {
      method: 'POST',
      headers: sendHeaders,
      body,
      signal,
      dispatcher: getLlmDispatcher(),
    });
  if (plain) return send(raw, headers);
  return sendGzipCompressed({ raw, headers, compress, send });
}
