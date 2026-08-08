/**
 * ChatGPT OAuth image adapter (`openai-oauth` lane).
 *
 * Runs the hosted `image_generation` tool on the Codex responses backend — the
 * same endpoint/headers the chat provider uses, so the subscription session is
 * the only credential involved. The final image arrives as base64 on the
 * image_generation_call item; partial frames are kept as a fallback.
 */
import { randomBytes } from 'crypto';
import { resolveCodexAuth } from '../auth.mjs';
import { mediaError } from '../lanes.mjs';
import { upstreamError } from '../upstream-error.mjs';
import { CODEX_OAUTH_ORIGINATOR, CODEX_RESPONSES_URL } from '../../agent/orchestrator/providers/openai-oauth.mjs';

const REQUEST_TIMEOUT_MS = 400_000;

function imageTool(options = {}) {
  const tool = { type: 'image_generation' };
  const size = String(options.size || 'auto');
  if (size && size !== 'auto') tool.size = size;
  const quality = String(options.quality || 'auto');
  if (quality && quality !== 'auto') tool.quality = quality;
  return tool;
}

function collectImage(event, state) {
  const item = event?.item;
  if (event?.type === 'response.output_item.done' && item?.type === 'image_generation_call') {
    if (typeof item.result === 'string' && item.result.length > 0) state.final = item.result;
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
    ...references.map((ref) => ({
      type: 'input_image',
      image_url: `data:${ref.mime || 'image/png'};base64,${ref.base64}`,
    })),
    { type: 'input_text', text: prompt },
  ];
  return {
    model,
    stream: true,
    store: false,
    instructions: 'You generate images with the image_generation tool. Call the tool once for the user request; do not ask follow-up questions.',
    input: [{ type: 'message', role: 'user', content }],
    tools: [imageTool(options)],
    // Smaller mainline models may answer with text when left on auto even
    // though they support the hosted tool. Studio always requests an image.
    tool_choice: { type: 'image_generation' },
  };
}

export async function generateImage({ model, prompt, options = {}, references = [], signal }) {
  const auth = await resolveCodexAuth();
  const body = codexImageRequestBody({ model, prompt, options, references });
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const res = await fetch(CODEX_RESPONSES_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${auth.access_token}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      'OpenAI-Beta': 'responses=experimental',
      originator: CODEX_OAUTH_ORIGINATOR,
      'chatgpt-account-id': auth.account_id || '',
      'x-client-request-id': randomBytes(16).toString('hex'),
    },
    body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!res.ok || !res.body) throw upstreamError('ChatGPT image', res.status, await res.text().catch(() => ''));

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
        try { event = JSON.parse(raw); } catch { continue; }
        if (event?.type === 'response.failed' || event?.type === 'error') {
          failure = event?.response?.error?.message || event?.message || 'stream failed';
        }
        collectImage(event, state);
      }
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }

  const b64 = state.final || state.partial;
  if (!b64) {
    throw mediaError(`ChatGPT returned no image data${failure ? `: ${failure}` : ''}`, 'MEDIA_EMPTY_RESULT', 502);
  }
  return { bytes: Buffer.from(b64, 'base64'), mime: 'image/png', revisedPrompt: state.revisedPrompt };
}
