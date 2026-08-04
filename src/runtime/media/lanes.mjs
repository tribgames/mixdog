/**
 * Media generation lanes (image / video).
 *
 * A lane is one credential path we can actually generate with. Auth state is
 * resolved from the SAME stores the chat providers use (OAuth token stores and
 * the keychain-backed API keys), so the Studio only ever offers lanes the user
 * already signed in to. No lane owns a fallback to another lane's credential —
 * an unauthenticated lane fails closed.
 */
import { hasAgentApiKey } from '../shared/provider-api-key.mjs';
// Credential probes are file-level checks: the catalog must not drag the whole
// provider graph in just to render lane availability.
import {
  hasGrokOAuthCredentials,
  hasOpenAIOAuthCredentials,
} from '../agent/orchestrator/providers/oauth-credential-probes.mjs';

export const MEDIA_KINDS = Object.freeze(['image', 'video']);

const GROK_IMAGE_MODELS = Object.freeze([
  Object.freeze({ id: 'grok-imagine-image', label: 'Imagine Image' }),
  Object.freeze({ id: 'grok-imagine-image-quality', label: 'Imagine Image Q' }),
]);
// Per-model control overrides: video contracts differ per model (fixed clip
// lengths on Veo, 1080p only on Grok 1.5, no length knob on Omni), so each
// entry carries what it actually accepts instead of one lane-wide guess.
const GROK_VIDEO_MODELS = Object.freeze([
  Object.freeze({
    id: 'grok-imagine-video',
    label: 'Imagine Video',
    controls: Object.freeze({ resolution: Object.freeze(['480p', '720p']) }),
  }),
]);
// grok-imagine-video-1.5 is intentionally absent: upstream rejects prompt-only
// text-to-video on it ("Text-to-video is not supported for this model"), and it
// only works through an image/reference input we do not accept yet.

// Aspect/resolution vocabularies are lane-native: xAI takes aspect_ratio +
// resolution, Gemini/Codex take pixel sizes. The UI renders whatever the lane
// declares instead of inventing a cross-provider size model.
const GROK_ASPECTS = Object.freeze(['auto', '1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3']);

const LANES = Object.freeze([
  Object.freeze({
    id: 'grok-oauth',
    label: 'Grok Imagine (OAuth)',
    auth: Object.freeze({ type: 'oauth', provider: 'grok-oauth' }),
    image: Object.freeze({
      models: GROK_IMAGE_MODELS,
      defaultModel: 'grok-imagine-image',
      controls: Object.freeze({ aspectRatio: GROK_ASPECTS, resolution: Object.freeze(['1k', '2k']), maxReferences: 5 }),
    }),
    video: Object.freeze({
      models: GROK_VIDEO_MODELS,
      defaultModel: 'grok-imagine-video',
      controls: Object.freeze({
        aspectRatio: GROK_ASPECTS,
        resolution: Object.freeze(['480p', '720p', '1080p']),
        durationRange: Object.freeze([1, 15]),
        // 1 ref = image-to-video, 2-7 = reference-to-video.
        maxReferences: 7,
      }),
    }),
  }),
  Object.freeze({
    id: 'xai',
    label: 'Grok Imagine (API key)',
    auth: Object.freeze({ type: 'api-key', provider: 'xai' }),
    image: Object.freeze({
      models: GROK_IMAGE_MODELS,
      defaultModel: 'grok-imagine-image',
      controls: Object.freeze({ aspectRatio: GROK_ASPECTS, resolution: Object.freeze(['1k', '2k']), maxReferences: 5 }),
    }),
    video: Object.freeze({
      models: GROK_VIDEO_MODELS,
      defaultModel: 'grok-imagine-video',
      controls: Object.freeze({
        aspectRatio: GROK_ASPECTS,
        resolution: Object.freeze(['480p', '720p', '1080p']),
        durationRange: Object.freeze([1, 15]),
        maxReferences: 7,
      }),
    }),
  }),
  Object.freeze({
    id: 'openai-oauth',
    label: 'ChatGPT Image (OAuth)',
    auth: Object.freeze({ type: 'oauth', provider: 'openai-oauth' }),
    image: Object.freeze({
      // The hosted image_generation tool runs on the Codex responses backend,
      // so the id is a chat model driving the tool. The catalog exposes it as
      // an IMAGE choice (quality vs fast) — listing raw chat models here read
      // as "why is a chat model in an image picker".
      models: Object.freeze([
        Object.freeze({ id: 'gpt-5.6-sol', label: 'GPT Image' }),
        Object.freeze({ id: 'gpt-5.4-mini', label: 'GPT Image Fast' }),
      ]),
      defaultModel: 'gpt-5.6-sol',
      controls: Object.freeze({
        size: Object.freeze(['auto', '1024x1024', '1536x1024', '1024x1536']),
        quality: Object.freeze(['auto', 'low', 'medium', 'high']),
        maxReferences: 5,
      }),
    }),
  }),
  Object.freeze({
    id: 'gemini',
    label: 'Gemini Image (API key)',
    auth: Object.freeze({ type: 'api-key', provider: 'gemini' }),
    image: Object.freeze({
      models: Object.freeze([
        Object.freeze({ id: 'gemini-3-pro-image', label: 'Nano Banana Pro' }),
        Object.freeze({ id: 'gemini-3.1-flash-image', label: 'Nano Banana 2' }),
        Object.freeze({ id: 'gemini-2.5-flash-image', label: 'Nano Banana 2.5' }),
      ]),
      defaultModel: 'gemini-3.1-flash-image',
      controls: Object.freeze({
        aspectRatio: Object.freeze(['auto', '1:1', '16:9', '9:16', '4:3', '3:4']),
        // Reference caps the image edit path at 3 inline references.
        maxReferences: 3,
      }),
    }),
    video: Object.freeze({
      // Omni Flash answers inline on the Interactions API; the Veo trio runs as
      // a long-running predict. Both are paid-tier only on this key.
      models: Object.freeze([
        Object.freeze({
          id: 'gemini-omni-flash-preview',
          label: 'Omni Flash',
          // Omni picks its own clip length; only the frame shape is ours.
          controls: Object.freeze({
            resolution: Object.freeze([]),
            durations: Object.freeze([]),
            maxReferences: 3,
          }),
        }),
        Object.freeze({ id: 'veo-3.1-fast-generate-preview', label: 'Veo 3.1 Fast' }),
        Object.freeze({ id: 'veo-3.1-generate-preview', label: 'Veo 3.1' }),
        Object.freeze({ id: 'veo-3.1-lite-generate-preview', label: 'Veo 3.1 Lite' }),
      ]),
      defaultModel: 'gemini-omni-flash-preview',
      controls: Object.freeze({
        aspectRatio: Object.freeze(['16:9', '9:16']),
        resolution: Object.freeze(['720p', '1080p']),
        // Veo 3.1 accepts discrete clip lengths, not a free range.
        durations: Object.freeze([4, 6, 8]),
        // Veo takes a single start frame; Omni overrides this below.
        maxReferences: 1,
      }),
    }),
  }),
]);

const LANE_BY_ID = new Map(LANES.map((lane) => [lane.id, lane]));

function laneAuthenticated(lane) {
  try {
    if (lane.auth.type === 'api-key') return hasAgentApiKey(lane.auth.provider);
    if (lane.auth.provider === 'grok-oauth') return hasGrokOAuthCredentials();
    if (lane.auth.provider === 'openai-oauth') return hasOpenAIOAuthCredentials();
  } catch {
    return false;
  }
  return false;
}

function laneKindView(lane, kind) {
  const spec = lane[kind];
  if (!spec) return null;
  const laneControls = spec.controls || {};
  return {
    // Each model publishes its EFFECTIVE controls (lane defaults + its own
    // overrides) so the UI never offers a knob the model rejects.
    models: spec.models.map((model) => ({
      id: model.id,
      label: model.label,
      controls: JSON.parse(JSON.stringify({ ...laneControls, ...(model.controls || {}) })),
    })),
    defaultModel: spec.defaultModel,
    controls: JSON.parse(JSON.stringify(laneControls)),
  };
}

/** Lane catalog with live auth state; the caller filters on `authenticated`. */
export function listMediaLanes() {
  return LANES.map((lane) => ({
    id: lane.id,
    label: lane.label,
    authType: lane.auth.type,
    authProvider: lane.auth.provider,
    authenticated: laneAuthenticated(lane),
    kinds: MEDIA_KINDS.filter((kind) => Boolean(lane[kind])),
    image: laneKindView(lane, 'image'),
    video: laneKindView(lane, 'video'),
  }));
}

export function getMediaLane(laneId) {
  return LANE_BY_ID.get(String(laneId || '').trim()) || null;
}

/**
 * Resolve + validate a generation request against the lane contract. Throws a
 * coded error rather than letting an unsupported model reach the network.
 */
export function resolveMediaRequest({ lane: laneId, kind, model } = {}) {
  const kindName = String(kind || '').trim();
  if (!MEDIA_KINDS.includes(kindName)) {
    throw mediaError(`unsupported media kind "${kindName}"`, 'MEDIA_KIND_UNSUPPORTED');
  }
  const lane = getMediaLane(laneId);
  if (!lane) throw mediaError(`unknown media lane "${laneId}"`, 'MEDIA_LANE_UNKNOWN');
  const spec = lane[kindName];
  if (!spec) throw mediaError(`${lane.id} does not support ${kindName}`, 'MEDIA_KIND_UNSUPPORTED');
  if (!laneAuthenticated(lane)) {
    throw mediaError(`${lane.label} is not authenticated — sign in from Settings → Providers first`, 'MEDIA_LANE_UNAUTHENTICATED');
  }
  const requested = String(model || '').trim() || spec.defaultModel;
  if (!spec.models.some((entry) => entry.id === requested)) {
    throw mediaError(`model "${requested}" is not available on ${lane.id}/${kindName}`, 'MEDIA_MODEL_UNSUPPORTED');
  }
  return { lane, kind: kindName, model: requested, spec };
}

export function mediaError(message, code, status = 400) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  return err;
}
