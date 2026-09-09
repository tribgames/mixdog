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
import { loadMediaModels, projectMediaModels } from './catalog.mjs';
import { catalogDiagnostic } from './catalog-errors.mjs';

export const MEDIA_KINDS = Object.freeze(['image', 'video']);

// Aspect/resolution vocabularies are lane-native: xAI takes aspect_ratio +
// resolution, Gemini/Codex take pixel sizes. The UI renders whatever the lane
// declares instead of inventing a cross-provider size model.
const GROK_ASPECTS = Object.freeze(['auto', '1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3']);

const LANES = Object.freeze([
  Object.freeze({
    id: 'grok-oauth',
    label: 'Grok Imagine',
    auth: Object.freeze({ type: 'oauth', provider: 'grok-oauth' }),
    image: Object.freeze({
      controls: Object.freeze({ aspectRatio: GROK_ASPECTS, resolution: Object.freeze(['1k', '2k']), maxReferences: 5 }),
    }),
    video: Object.freeze({
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
    label: 'Grok Imagine',
    auth: Object.freeze({ type: 'api-key', provider: 'xai' }),
    image: Object.freeze({
      controls: Object.freeze({ aspectRatio: GROK_ASPECTS, resolution: Object.freeze(['1k', '2k']), maxReferences: 5 }),
    }),
    video: Object.freeze({
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
    label: 'OpenAI Images',
    auth: Object.freeze({ type: 'oauth', provider: 'openai-oauth' }),
    image: Object.freeze({
      controls: Object.freeze({
        maxReferences: 5,
      }),
    }),
  }),
  Object.freeze({
    id: 'gemini',
    label: 'Google Gemini',
    auth: Object.freeze({ type: 'api-key', provider: 'gemini' }),
    image: Object.freeze({
      controls: Object.freeze({
        aspectRatio: Object.freeze(['auto', '1:1', '16:9', '9:16', '4:3', '3:4']),
        // Reference caps the image edit path at 3 inline references.
        maxReferences: 3,
      }),
    }),
    video: Object.freeze({
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

function laneKindView(lane, kind, models) {
  const spec = lane[kind];
  if (!spec || !models.length) return null;
  const laneControls = spec.controls || {};
  return {
    // Each model publishes its EFFECTIVE controls (lane defaults + its own
    // overrides) so the UI never offers a knob the model rejects.
    models: models.map((model) => ({
      id: model.id,
      label: model.label,
      ...(model.description ? { description: model.description } : {}),
      ...(model.requestModel ? { requestModel: model.requestModel } : {}),
      controls: JSON.parse(JSON.stringify({ ...laneControls, ...(model.controls || {}) })),
    })),
    defaultModel: models[0].id,
    controls: JSON.parse(JSON.stringify(laneControls)),
  };
}

export function createMediaLaneCatalog({
  loadModels = loadMediaModels,
  authenticated = laneAuthenticated,
} = {}) {
  async function laneView(lane) {
    const signedIn = authenticated(lane);
    const view = {
      id: lane.id, label: lane.label,
      authType: lane.auth.type, authProvider: lane.auth.provider,
      authenticated: signedIn, kinds: [], image: null, video: null,
    };
    if (!signedIn) return view;
    try {
      const rows = await loadModels(lane.id);
      const models = projectMediaModels(lane.id, rows);
      if (rows.catalogWarning) view.catalogWarning = rows.catalogWarning;
      for (const kind of MEDIA_KINDS) {
        view[kind] = laneKindView(lane, kind, models[kind]);
        if (view[kind]) view.kinds.push(kind);
      }
    } catch (error) {
      const diagnostic = catalogDiagnostic(error);
      if (diagnostic.code === 'MEDIA_BILLING_BLOCKED') {
        // Unusable connections are absent from public catalogs. Keep only a
        // sanitized internal reason, never the upstream body or account id.
        try {
          console.warn(`[media] catalog excluded lane=${lane.id} code=${diagnostic.code}`);
        } catch { /* diagnostics must not affect catalog availability */ }
        return null;
      }
      view.catalogErrorCode = diagnostic.code;
      view.catalogError = `${lane.label} (${lane.auth.type === 'oauth' ? 'Account' : 'API key'}): ${diagnostic.message}`;
    }
    return view;
  }

  return {
    /** Live catalog shared by Studio and the model-facing media tool. */
    async listMediaLanes() {
      return (await Promise.all(LANES.map(laneView))).filter(Boolean);
    },
    async resolveMediaRequest({ lane: laneId, kind, model } = {}) {
      const kindName = String(kind || '').trim();
      if (!MEDIA_KINDS.includes(kindName)) {
        throw mediaError(`unsupported media kind "${kindName}"`, 'MEDIA_KIND_UNSUPPORTED');
      }
      const definition = LANE_BY_ID.get(String(laneId || '').trim());
      if (!definition) throw mediaError(`unknown media lane "${laneId}"`, 'MEDIA_LANE_UNKNOWN');
      if (!definition[kindName]) throw mediaError(`${definition.id} does not support ${kindName}`, 'MEDIA_KIND_UNSUPPORTED');
      const lane = await laneView(definition);
      if (!lane) {
        throw mediaError('The selected media model is not available.', 'MEDIA_MODEL_UNSUPPORTED');
      }
      if (!lane.authenticated) {
        throw mediaError(`${lane.label} is not authenticated — sign in from Settings → Providers first`, 'MEDIA_LANE_UNAUTHENTICATED');
      }
      if (lane.catalogError) throw mediaError(lane.catalogError, lane.catalogErrorCode || 'MEDIA_CATALOG_UNAVAILABLE', 503);
      const spec = lane[kindName];
      const requested = String(model || '').trim() || spec?.defaultModel;
      if (!spec?.models.some((entry) => entry.id === requested)) {
        throw mediaError(`model "${requested || ''}" is not available on ${lane.id}/${kindName}`, 'MEDIA_MODEL_UNSUPPORTED');
      }
      return { lane, kind: kindName, model: requested, spec };
    },
  };
}

export const { listMediaLanes, resolveMediaRequest } = createMediaLaneCatalog();

export function mediaError(message, code, status = 400) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  return err;
}
