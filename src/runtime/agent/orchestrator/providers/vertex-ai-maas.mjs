import { currentUsageContext } from '../../../shared/llm/usage-context.mjs';
import { noteErrorUsage } from './lib/note-error-usage.mjs';
import { OpenAICompatProvider } from './openai-compat.mjs';

// Gives an OpenAI-compatible engine the current access token of one account
// (from the Vertex token manager) as its API key. The engine never resolves a
// key of its own, so a stored credential is never sent as a bearer.
export class ApiKeySetter {
  constructor(auth) {
    this.auth = auth;
  }

  async set(engine, identity) {
    const token = await this.auth.getAccessToken({ identity });
    this.auth.assertIdentity(identity);
    if (engine.apiKey !== token) {
      engine.apiKey = token;
      engine.config = { ...engine.config, apiKey: token };
      engine.client = engine._createClient(token);
    }
    return token;
  }
}

// Vertex usage is cache-exclusive (VertexAIProvider.inputExcludesCache): input
// is the uncached remainder. Gemini's promptTokenCount and Chat Completions'
// prompt_tokens both include the cached prefix, so both routes convert here.
// One source object always converts to the same object, and a converted one
// passes through unchanged, so an abandoned attempt stays one record.
const exclusiveUsage = new WeakSet();
const convertedUsage = new WeakMap();

export function toVertexExclusiveUsage(usage) {
  if (!usage || typeof usage !== 'object' || exclusiveUsage.has(usage)) return usage;
  if (convertedUsage.has(usage)) return convertedUsage.get(usage);
  const input = Number(usage.inputTokens) || 0;
  const cached = (Number(usage.cachedTokens) || 0) + (Number(usage.cacheWriteTokens) || 0);
  const converted = {
    ...usage,
    inputTokens: Math.max(0, input - cached),
    promptTokens: Math.max(Number(usage.promptTokens) || 0, input),
  };
  exclusiveUsage.add(converted);
  convertedUsage.set(usage, converted);
  return converted;
}

function exclusiveError(error) {
  if (error && typeof error === 'object') {
    if (error.usage) error.usage = toVertexExclusiveUsage(error.usage);
    if (error.partialUsage) error.partialUsage = toVertexExclusiveUsage(error.partialUsage);
  }
  return error;
}

const httpStatus = (error) =>
  [error?.status, error?.httpStatus, error?.response?.status]
    .map(Number)
    .find((value) => Number.isFinite(value) && value > 0) || 0;
const emittedOutput = (error) =>
  error?.liveTextEmitted === true || error?.emittedToolCall === true || error?.unsafeToRetry === true;

// Vertex may answer an error with a JSON array of error objects
// (`[{"error":{…}}]`), which the OpenAI SDK reads as "no body"; the first
// entry is handed on as the usual `{"error":{…}}` object.
function unwrapErrorList(fetchFn) {
  return async (url, init) => {
    const response = await fetchFn(url, init);
    if (response.ok || !/json/i.test(response.headers.get('content-type') || '')) return response;
    const text = await response.text();
    let body = text;
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed) && parsed[0]?.error) body = JSON.stringify(parsed[0]);
    } catch {}
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

// The OpenAI-compatible transport on a Vertex bearer: its own key lookup and
// 401 re-read would reach the stored service-account JSON, so the route sends
// through _doSend and owns the credential.
class VertexMaasEngine extends OpenAICompatProvider {
  reloadApiKey() {}
}

/**
 * Open and partner models (every publisher but Google's Gemini and Anthropic)
 * on `projects/P/locations/L/endpoints/openapi/chat/completions`.
 */
export class VertexMaasRoute {
  constructor({ name, config, auth, fetchFn }) {
    this.name = name;
    this.config = config;
    this.auth = auth;
    this.fetchFn = fetchFn;
    this.setter = new ApiKeySetter(auth);
    this.engines = new Map();
  }

  _engine(baseURL, token) {
    let engine = this.engines.get(baseURL);
    if (!engine) {
      const { apiKey: _key, apiKeyEnv: _env, fetchFn: _fetch, now: _now, sleepFn: _sleep, ...config } = this.config;
      engine = new VertexMaasEngine(this.name, {
        ...config,
        baseURL,
        apiKey: token,
        // Explicit nulls keep OPENAI_ORG_ID / OPENAI_PROJECT_ID out of the requests.
        clientOptions: {
          organization: null,
          project: null,
          fetch: unwrapErrorList(this.fetchFn || ((url, init) => fetch(url, init))),
        },
      });
      this.engines.set(baseURL, engine);
    }
    return engine;
  }

  /** `baseURL` and `identity` are the account the caller built the URL for. */
  async send(messages, model, tools, opts, { baseURL, identity }) {
    const identityContext = currentUsageContext();
    if (identityContext) identityContext.normalizeAbandonedUsage = toVertexExclusiveUsage;
    const token = await this.auth.getAccessToken({ identity });
    const engine = this._engine(baseURL, token);
    const attempt = async () => {
      const sent = await this.setter.set(engine, identity);
      try {
        return { result: await engine._doSend(messages, model, tools, opts) };
      } catch (error) {
        noteErrorUsage(error);
        return { error, token: sent };
      }
    };
    let outcome = await attempt();
    if (outcome.error && httpStatus(outcome.error) === 401 && !emittedOutput(outcome.error)) {
      this.auth.invalidate(outcome.token);
      outcome = await attempt();
    }
    if (outcome.error) throw exclusiveError(outcome.error);
    const { result } = outcome;
    return result?.usage ? { ...result, usage: toVertexExclusiveUsage(result.usage) } : result;
  }
}
