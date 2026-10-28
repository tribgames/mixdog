import { AsyncLocalStorage } from 'node:async_hooks';
import { currentUsageContext } from '../../../shared/llm/usage-context.mjs';
import { noteErrorUsage } from './lib/note-error-usage.mjs';
import { OpenAICompatProvider } from './openai-compat.mjs';
import { vertexHttpStatus } from './vertex-ai-models.mjs';

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

const emittedOutput = (error) =>
  error?.liveTextEmitted === true || error?.emittedToolCall === true || error?.unsafeToRetry === true;

/**
 * Vertex may answer an error with a JSON array of error objects
 * (`[{"error":{…}}]`); the first entry is the usual `{"error":{…}}` body.
 * Any other text is returned unchanged.
 */
export function vertexErrorBody(text) {
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed) && parsed[0]?.error) return JSON.stringify(parsed[0]);
  } catch {}
  return text;
}

// The account one send targets ({ identity, token }), read by its engine's
// fetch on every HTTP attempt, the engine's own retries included.
const sendAccount = new AsyncLocalStorage();

// Each HTTP attempt carries the send's account's current token, and a
// credential switch since the send began aborts it before anything is sent.
// The OpenAI SDK reads an array error body as "no body", so it is unwrapped.
function vertexEngineFetch(fetchFn, auth) {
  return async (url, init) => {
    const account = sendAccount.getStore();
    let request = init;
    if (account) {
      account.token = await auth.getAccessToken({ identity: account.identity });
      auth.assertIdentity(account.identity);
      const headers = new Headers(init?.headers || {});
      headers.set('Authorization', `Bearer ${account.token}`);
      request = { ...init, headers };
    }
    const response = await fetchFn(url, request);
    if (response.ok || !/json/i.test(response.headers.get('content-type') || '')) return response;
    const body = vertexErrorBody(await response.text());
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

// Open-model reasoning controls (Thinking for open models, checked
// 2026-10-28): gpt-oss takes `reasoning_effort` low/medium/high. Grok
// reasoning models reject it; the others document no effort parameter.
const GPT_OSS_EFFORTS = new Set(['low', 'medium', 'high']);
const MAAS_CHAT_PROFILE = Object.freeze({
  applyParams(params, { opts, config }) {
    if (!/^openai\/gpt-oss-/i.test(String(params.model || ''))) return;
    const effort = String(opts?.effort ?? config?.reasoningEffort ?? '')
      .trim()
      .toLowerCase();
    if (GPT_OSS_EFFORTS.has(effort)) params.reasoning_effort = effort;
  },
  // The SDK wraps a fetch failure as a (retryable) connection error; a
  // credential switch surfaces as itself, so no attempt retries it.
  refineError(error) {
    return error?.cause?.code === 'EVERTEXAUTH' ? error.cause : error;
  },
});

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
        chatProfile: MAAS_CHAT_PROFILE,
        // Explicit nulls keep OPENAI_ORG_ID / OPENAI_PROJECT_ID out of the requests.
        clientOptions: {
          organization: null,
          project: null,
          fetch: vertexEngineFetch(this.fetchFn || ((url, init) => fetch(url, init)), this.auth),
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
      const account = { identity, token: await this.setter.set(engine, identity) };
      try {
        return { result: await sendAccount.run(account, () => engine._doSend(messages, model, tools, opts)) };
      } catch (error) {
        noteErrorUsage(error);
        // The token the last HTTP attempt actually carried.
        return { error, token: account.token };
      }
    };
    let outcome = await attempt();
    if (outcome.error && vertexHttpStatus(outcome.error) === 401 && !emittedOutput(outcome.error)) {
      this.auth.invalidate(outcome.token);
      outcome = await attempt();
    }
    if (outcome.error) throw exclusiveError(outcome.error);
    const { result } = outcome;
    return result?.usage ? { ...result, usage: toVertexExclusiveUsage(result.usage) } : result;
  }
}
