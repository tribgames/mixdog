/**
 * ChatGPT OAuth image adapter (`openai-oauth` lane).
 *
 * Primary path: the subscription's Images endpoints on the Codex backend
 * (`images/generations`, or `images/edits` when reference images are given),
 * a plain JSON request answered with the finished image as base64.
 *
 * Fallback path, used only when those endpoints are not served (404/405/501,
 * or the edge's HTML 403 for an unknown route): the hosted `image_generation`
 * tool on the responses backend. Its final image arrives on the
 * image_generation_call item; a stream that only produced partial preview
 * frames fails instead of saving a draft as the result.
 *
 * Both paths use the chat provider's session, so the subscription login is the
 * only credential involved. Usage-limit failures name the reset time, looked up
 * from the account's usage summary when the failure itself omits it.
 */
import { randomBytes } from 'node:crypto';
import { resolveCodexAuth } from '../auth.mjs';
import { timeoutSignal } from '../bounded-signal.mjs';
import { chatgptLimitResetAt } from '../chatgpt-usage.mjs';
import { decodeBase64Media } from '../download.mjs';
import { mediaError } from '../lanes.mjs';
import { upstreamError, usageLimitError, usageLimitFromResponse, usageLimitInfo } from '../upstream-error.mjs';
import { responsesUsage, withReportedUsage } from '../media-usage.mjs';
import { CODEX_OAUTH_ORIGINATOR, CODEX_RESPONSES_URL } from '../../agent/orchestrator/providers/openai-oauth.mjs';
import {
  codexUserAgent,
  codexVersionHeader,
  warmCodexClientVersion,
} from '../../agent/orchestrator/providers/codex-client-meta.mjs';

const REQUEST_TIMEOUT_MS = 400_000;
const LABEL = 'ChatGPT image';
export const CODEX_IMAGE_MODEL = 'gpt-image-2';
export const CODEX_IMAGES_GENERATIONS_URL = new URL('images/generations', CODEX_RESPONSES_URL).href;
export const CODEX_IMAGES_EDITS_URL = new URL('images/edits', CODEX_RESPONSES_URL).href;
const BACKGROUNDS = new Set(['transparent', 'opaque', 'auto']);

const dataUrl = (ref) => `data:${ref.mime || 'image/png'};base64,${ref.base64}`;

function imageTool(options = {}) {
  const tool = { type: 'image_generation' };
  const size = String(options.size || 'auto');
  if (size && size !== 'auto') tool.size = size;
  const quality = String(options.quality || 'auto');
  if (quality && quality !== 'auto') tool.quality = quality;
  if (options.background && options.background !== 'auto') tool.background = options.background;
  return tool;
}

/** Images endpoint request: generation, or an edit when references are given. */
export function codexImagesRequest({ prompt, options = {}, references = [] }) {
  const body = { prompt, model: CODEX_IMAGE_MODEL, size: 'auto', quality: 'auto' };
  if (options.background) body.background = options.background;
  if (!references.length) return { url: CODEX_IMAGES_GENERATIONS_URL, body };
  return {
    url: CODEX_IMAGES_EDITS_URL,
    body: { images: references.map((ref) => ({ image_url: dataUrl(ref) })), ...body },
  };
}

export function codexImagesRequestHeaders(auth) {
  const headers = {
    Authorization: `Bearer ${auth.access_token}`,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    originator: CODEX_OAUTH_ORIGINATOR,
    'x-client-request-id': randomBytes(16).toString('hex'),
    version: codexVersionHeader(),
    'User-Agent': codexUserAgent(),
  };
  if (auth.account_id) headers['ChatGPT-Account-ID'] = auth.account_id;
  return headers;
}

// The endpoint is not served for this backend: a missing route or method, or
// the edge's HTML 403 page that unknown backend routes answer with. Auth,
// billing and limit failures come back as JSON and are reported, not retried.
function imagesEndpointUnavailable(res) {
  if ([404, 405, 501].includes(res.status)) return true;
  return res.status === 403 && !/json/i.test(res.headers.get('content-type') || '');
}

function imagesUsage(usage) {
  const tokens = responsesUsage(usage);
  const imageTokens = Math.trunc(Number(usage?.output_tokens_details?.image_tokens) || 0);
  return imageTokens > 0 ? { ...tokens, outputImageTokens: imageTokens } : tokens;
}

async function limitError(limit, { auth, fetchFn, lookupReset, signal }) {
  const resetsAt = limit.resetsAt || (await lookupReset({ auth, limitId: limit.limitId, fetchFn, signal }));
  return usageLimitError(LABEL, { limitId: limit.limitId, resetsAt });
}

async function failedResponse(res, ctx) {
  const text = await res.text().catch(() => '');
  const limit = usageLimitFromResponse(res.status, text, res.headers);
  if (limit) return await limitError(limit, ctx);
  return upstreamError(LABEL, res.status, text);
}

/** Returns the image, or null when the Images endpoint is unavailable. */
async function generateViaImagesEndpoint({ prompt, options, references, signal }, ctx) {
  const { url, body } = codexImagesRequest({ prompt, options, references });
  const res = await ctx.fetchFn(url, {
    method: 'POST',
    headers: codexImagesRequestHeaders(ctx.auth),
    body: JSON.stringify(body),
    redirect: 'error',
    signal: timeoutSignal(signal, REQUEST_TIMEOUT_MS),
  });
  if (imagesEndpointUnavailable(res)) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  if (!res.ok) throw await failedResponse(res, ctx);
  const json = await res.json().catch(() => null);
  const usage = imagesUsage(json?.usage);
  const b64 = json?.data?.[0]?.b64_json;
  if (typeof b64 !== 'string' || !b64) {
    throw withReportedUsage(mediaError(`${LABEL}: returned no image data`, 'MEDIA_EMPTY_RESULT', 502), usage);
  }
  return {
    bytes: decodeBase64Media(b64, LABEL),
    mime: 'image/png',
    revisedPrompt: null,
    actualModel: CODEX_IMAGE_MODEL,
    usage: usage || null,
  };
}

function collectImage(event, state) {
  const item = event?.item;
  // Terminal Responses events carry the orchestrator's token usage. It does
  // not include the hosted image tool's own tokens.
  if (['response.completed', 'response.failed', 'response.incomplete'].includes(event?.type)) {
    state.usage = responsesUsage(event?.response?.usage) || state.usage;
    return;
  }
  if (event?.type === 'response.output_item.done' && item?.type === 'image_generation_call') {
    if (typeof item.result === 'string' && item.result.length > 0) state.final = item.result;
    if (typeof item.model === 'string') state.actualModel = item.model;
    if (typeof item.revised_prompt === 'string') state.revisedPrompt = item.revised_prompt;
    return;
  }
  if (event?.type === 'response.image_generation_call.partial_image') {
    const partial = event?.partial_image_b64;
    if (typeof partial === 'string' && partial.length > (state.partial?.length || 0)) state.partial = partial;
  }
}

export function codexImageRequestBody({ model, prompt, options = {}, references = [] }) {
  // Reference images ride as input_image parts on the user turn — the same
  // shape the chat path uses for pasted images.
  const content = [
    ...references.map((ref) => ({ type: 'input_image', image_url: dataUrl(ref) })),
    { type: 'input_text', text: prompt },
  ];
  return {
    model,
    stream: true,
    store: false,
    instructions:
      'You generate images with the image_generation tool. Call the tool once for the user request; do not ask follow-up questions.',
    input: [{ type: 'message', role: 'user', content }],
    tools: [imageTool(options)],
    // Smaller mainline models may answer with text when left on auto even
    // though they support the hosted tool. Studio always requests an image.
    tool_choice: { type: 'image_generation' },
  };
}

export function codexImageRequestHeaders(auth) {
  return {
    Authorization: `Bearer ${auth.access_token}`,
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    'OpenAI-Beta': 'responses=experimental',
    originator: CODEX_OAUTH_ORIGINATOR,
    'chatgpt-account-id': auth.account_id || '',
    'x-client-request-id': randomBytes(16).toString('hex'),
    version: codexVersionHeader(),
    'User-Agent': codexUserAgent(),
  };
}

export async function generateImage(
  { model, prompt, options = {}, references = [], signal },
  {
    fetchFn = fetch,
    resolveAuth = resolveCodexAuth,
    warmVersion = warmCodexClientVersion,
    lookupReset = chatgptLimitResetAt,
  } = {}
) {
  if (['size', 'quality', 'resolution', 'aspectRatio'].some((key) => options[key] && options[key] !== 'auto')) {
    throw mediaError(
      'ChatGPT selects image output settings; explicit size and quality are not supported on this connection.',
      'MEDIA_OPTION_UNSUPPORTED'
    );
  }
  if (options.background && !BACKGROUNDS.has(options.background)) {
    throw mediaError('background must be transparent, opaque or auto.', 'MEDIA_OPTION_UNSUPPORTED');
  }
  const auth = await resolveAuth();
  // Discovery and generation must report the same client version; otherwise
  // a newly discovered model can still be rejected by the Codex version gate.
  await warmVersion();
  const ctx = { auth, fetchFn, lookupReset, signal };
  const image = await generateViaImagesEndpoint({ prompt, options, references, signal }, ctx);
  return image || (await generateViaResponses({ model, prompt, options, references, signal }, ctx));
}

async function generateViaResponses({ model, prompt, options, references, signal }, ctx) {
  const body = codexImageRequestBody({ model, prompt, options, references });
  const res = await ctx.fetchFn(CODEX_RESPONSES_URL, {
    method: 'POST',
    headers: codexImageRequestHeaders(ctx.auth),
    body: JSON.stringify(body),
    redirect: 'error',
    signal: timeoutSignal(signal, REQUEST_TIMEOUT_MS),
  });
  if (!res.ok || !res.body) throw await failedResponse(res, ctx);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const state = { final: '', partial: '', revisedPrompt: null };
  let buffer = '';
  let failure = null;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        const raw = line.slice(5).trim();
        if (!raw || raw === '[DONE]') continue;
        let event;
        try {
          event = JSON.parse(raw);
        } catch {
          continue;
        }
        if (event?.type === 'response.failed' || event?.type === 'error') {
          // A top-level `error` event carries code/type/resets_at on itself.
          failure = event?.response?.error || event?.error || event;
        }
        collectImage(event, state);
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {}
  }

  if (!state.final) {
    const limit = failure && usageLimitInfo(failure, res.headers);
    if (limit) throw withReportedUsage(await limitError(limit, ctx), state.usage);
    const reason = (typeof failure === 'string' ? failure : failure?.message) || 'stream failed';
    // A partial frame is a low-fidelity preview of an unfinished render; it is
    // never saved as the result.
    const error = state.partial
      ? mediaError(
          `${LABEL}: generation stopped after a partial preview; no final image was produced${failure ? ` (${reason})` : ''}`,
          'MEDIA_PARTIAL_ONLY',
          502
        )
      : mediaError(`ChatGPT returned no image data${failure ? `: ${reason}` : ''}`, 'MEDIA_EMPTY_RESULT', 502);
    throw withReportedUsage(error, state.usage);
  }
  return {
    bytes: decodeBase64Media(state.final, LABEL),
    mime: 'image/png',
    revisedPrompt: state.revisedPrompt,
    actualModel: state.actualModel || null,
    usage: state.usage || null,
  };
}
