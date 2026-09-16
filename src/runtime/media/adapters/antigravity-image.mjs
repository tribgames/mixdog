/**
 * Antigravity image adapter (`antigravity-oauth` lane).
 *
 * Nano Banana models behind the Cloud Code Assist gateway take the same
 * Gemini `generateContent` payload as the API-key lane, wrapped in the gateway
 * envelope the chat provider sends. Only the streaming route returns image
 * parts: the unary route answers 200 with an empty candidate list. The image
 * arrives as one inline part; the whole SSE body is read before decoding.
 */
import { randomUUID } from 'node:crypto';
import { resolveAntigravityAuth } from '../auth.mjs';
import { upstreamError } from '../upstream-error.mjs';
import { geminiImageRequestBody, pickGeminiImagePart } from './gemini-image.mjs';
import { CONTENT_ENDPOINTS, antigravityHeaders } from '../../agent/orchestrator/providers/antigravity-oauth-tokens.mjs';
import { frameAndParseSse } from '../../agent/orchestrator/providers/lib/sse-framing.mjs';

const REQUEST_TIMEOUT_MS = 180_000;

function antigravityImageRequestBody({ projectId, model, prompt, options = {}, references = [] }) {
  return {
    project: projectId,
    model,
    userAgent: 'antigravity',
    requestType: 'agent',
    requestId: `agent-${randomUUID()}`,
    request: {
      ...geminiImageRequestBody(prompt, options, references),
      sessionId: `-${randomUUID()}`,
    },
  };
}

/** Candidate parts across the stream; the gateway nests each chunk under `response`. */
export function antigravityImageParts(sseText) {
  const parts = [];
  let failure = null;
  for (const event of frameAndParseSse(sseText).events) {
    if (event.error) continue;
    const value = event.value;
    // In-band error events stay top level; content chunks are nested.
    if (value?.error) failure = value.error.message || JSON.stringify(value.error);
    const chunk = value?.response && typeof value.response === 'object' ? value.response : value;
    const candidate = chunk?.candidates?.[0];
    parts.push(...(candidate?.content?.parts || []));
    const blocked = chunk?.promptFeedback?.blockReason;
    if (blocked && !failure) failure = `prompt blocked (${blocked})`;
  }
  return { parts, failure };
}

export async function generateImage(
  { model, prompt, options = {}, references = [], signal },
  { fetchFn = fetch, resolveAuth = resolveAntigravityAuth, endpoint = CONTENT_ENDPOINTS[0] } = {}
) {
  const auth = await resolveAuth();
  const body = antigravityImageRequestBody({ projectId: auth.projectId, model, prompt, options, references });
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const res = await fetchFn(`${endpoint}/v1internal:streamGenerateContent?alt=sse`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${auth.token}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      ...antigravityHeaders(),
    },
    body: JSON.stringify(body),
    redirect: 'error',
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!res.ok) throw upstreamError('Antigravity image', res.status, await res.text().catch(() => ''));
  const { parts, failure } = antigravityImageParts(await res.text());
  return pickGeminiImagePart(parts, 'Antigravity', failure);
}
