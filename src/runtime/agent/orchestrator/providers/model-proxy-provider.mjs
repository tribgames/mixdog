// Daemon-side stand-in for a provider in remote mode (MIXDOG_MODEL_PROXY=client).
// It holds no credentials and opens no model connection: every call is handed
// to the desktop client through the model proxy channel and executed by the
// PC's own provider of the same name. The registry still wraps it with
// admission scheduling and usage accounting, which then see the PC's result.
import {
  getModelProxyChannel,
  ModelProxyUnavailableError,
  splitModelProxySendOptions,
  stripModelProxySecrets,
} from './model-proxy-channel.mjs';
import {
  isFinalizedProviderRequestTools,
  providerNativeToolPrefixCount,
} from '../runtime-core/provider-request-tools.mjs';
import {
  attachmentTextForPart,
  isAttachmentReference,
  isPermanentAttachmentError,
  readAttachmentBuffer,
} from '../../../attachments/store.mjs';
import { MAX_ATTACHMENT_BLOB_BYTES } from '../../../attachments/limits.mjs';
import { isModelProxyUsageAccount } from './model-proxy-usage-wire.mjs';

/** Stored-attachment bytes one proxied call may carry inline: the store's own
 *  single-blob ceiling. Newer messages are inlined first; a reference past the
 *  budget stays a reference, which the PC lowers to its "unavailable" text. */
export const MODEL_PROXY_INLINE_MAX_BYTES = MAX_ATTACHMENT_BLOB_BYTES;

// A stored reference names a blob in THIS daemon's attachment store, which the
// PC running the call cannot read. Each one travels as the inline part it was
// stored from (image/file → base64 `data`, text → its text), so the PC lowers
// exactly what a local daemon would.
function inlineReference(part, budget) {
  let buffer;
  try {
    buffer = readAttachmentBuffer(part);
  } catch (error) {
    if (isPermanentAttachmentError(error)) return part;
    throw error;
  }
  if (buffer.length > budget.remaining) return part;
  budget.remaining -= buffer.length;
  const { attachmentRef: _ref, sizeBytes: _size, ...rest } = part;
  if (part.type === 'text') {
    const { textKind: _kind, filename: _name, mimeType: _mime, ...textRest } = rest;
    return { ...textRest, type: 'text', text: attachmentTextForPart(part) };
  }
  return { ...rest, data: buffer.toString('base64') };
}

function inlinePart(part, budget) {
  if (!part || typeof part !== 'object' || Array.isArray(part)) return part;
  if (isAttachmentReference(part)) return inlineReference(part, budget);
  if (Array.isArray(part.content)) {
    const content = inlineParts(part.content, budget);
    return content === part.content ? part : { ...part, content };
  }
  return part;
}

/** Newest last in a content list, so it is walked backwards for the budget. */
function inlineParts(parts, budget) {
  let out = null;
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const next = inlinePart(parts[index], budget);
    if (next === parts[index]) continue;
    out ??= [...parts];
    out[index] = next;
  }
  return out ?? parts;
}

/** `messages` with every stored attachment reference replaced by its bytes. */
export function inlineModelProxyAttachments(messages, { maxBytes = MODEL_PROXY_INLINE_MAX_BYTES } = {}) {
  if (!Array.isArray(messages)) return messages;
  const budget = { remaining: maxBytes };
  let out = null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || typeof message !== 'object' || message.content == null || typeof message.content === 'string') {
      continue;
    }
    const content = Array.isArray(message.content)
      ? inlineParts(message.content, budget)
      : inlinePart(message.content, budget);
    if (content === message.content) continue;
    out ??= [...messages];
    out[index] = { ...message, content };
  }
  return out ?? messages;
}

/** A first-response budget the PC reported, or null for anything malformed. */
function reportedBudget(value) {
  const transportMs = Number(value?.transportMs);
  const semanticMs = Number(value?.semanticMs);
  return transportMs > 0 && semanticMs > 0 && Number.isFinite(transportMs) && Number.isFinite(semanticMs)
    ? { transportMs, semanticMs }
    : null;
}

export class ModelProxyProvider {
  #channel;
  #modelInfo = new Map();
  #noWireRoute = new Set();

  constructor(name, config = {}, channel = getModelProxyChannel()) {
    this.name = name;
    this.config = config || {};
    this.#channel = channel;
    // Adapter traits are reported by the PC's real instance.
    if (typeof this.config.modelProxy?.nativePdf === 'boolean') this.nativePdf = this.config.modelProxy.nativePdf;
    if (this.config.modelProxy?.consumesReadWindows === true) this.consumesReadWindows = true;
  }

  usageAccountId(result) {
    return isModelProxyUsageAccount(result?.modelProxyUsageAccount)
      ? result.modelProxyUsageAccount
      : 'proxy-unattributed';
  }

  #call(method, fields = {}, options = {}) {
    return this.#channel.request({ provider: this.name, method, ...fields }, options);
  }

  async send(messages, model, tools, sendOpts) {
    const { options, callbacks } = splitModelProxySendOptions(sendOpts);
    const finalized = isFinalizedProviderRequestTools(tools);
    const fields = {
      model: model ?? null,
      messages: inlineModelProxyAttachments(messages),
      tools: Array.isArray(tools) ? tools : null,
      toolsFinalized: finalized,
      nativePrefixCount: finalized ? providerNativeToolPrefixCount(tools) : 0,
      options,
    };
    const signal = sendOpts?.signal || null;
    const result = await this.#call('send', fields, { signal, callbacks });
    // The PC rerouted the wire (a clear "unsupported" refusal) and reports the
    // route it used: the daemon's own session adopts it, so the next proxied
    // turn starts on the new wire instead of repeating the refusal.
    const rerouted = result?.wireReroute;
    const session = sendOpts?.session;
    if (
      rerouted?.source === 'reroute' &&
      session?.wireRoute &&
      session.wireRoute.provider === this.name &&
      session.wireRoute.model === (model ?? null) &&
      rerouted.provider === this.name &&
      rerouted.model === session.wireRoute.model
    ) {
      session.wireRoute = rerouted;
    }
    return result;
  }

  #adoptCatalog(catalog) {
    const models = Array.isArray(catalog?.models) ? catalog.models : [];
    const info = catalog?.modelInfo && typeof catalog.modelInfo === 'object' ? catalog.modelInfo : {};
    this.#modelInfo = new Map(Object.entries(info));
    return models;
  }

  async listModels() {
    return this.#adoptCatalog(await this.#call('listModels'));
  }

  async _refreshModelCache() {
    return this.#adoptCatalog(await this.#call('refreshModels'));
  }

  async isAvailable() {
    return (await this.#call('isAvailable')) === true;
  }

  getCachedModelInfo(model) {
    return this.#modelInfo.get(String(model ?? '')) ?? null;
  }

  /** The PC adapter's first-response budget for `model`: the catalog's
   *  model-specific figure, else the adapter's own from its provider config;
   *  null keeps the agent watchdog default. */
  firstResponseBudget(model) {
    return (
      reportedBudget(this.getCachedModelInfo(model)?.firstResponseBudget) ??
      reportedBudget(this.config.modelProxy?.firstResponseBudget)
    );
  }

  /** The PC adapter's wire route for `model` (its config and roster decide);
   *  null for a single-wire adapter, which is remembered so every later turn
   *  skips the round trip. */
  async resolveWireRoute(model, ctx = {}) {
    const key = String(model ?? '');
    if (this.#noWireRoute.has(key)) return null;
    const route = await this.#call('resolveWireRoute', {
      model: model ?? null,
      context: { agent: ctx.agent === true, legacy: ctx.legacy === true },
    });
    if (route && typeof route === 'object') return route;
    this.#noWireRoute.add(key);
    return null;
  }
}

/** A proxy instance whose class carries the PC adapter's usage convention. */
export function createModelProxyProvider(name, config = {}, channel = getModelProxyChannel()) {
  const inputExcludesCache = config?.modelProxy?.inputExcludesCache;
  if (typeof inputExcludesCache !== 'boolean') return new ModelProxyProvider(name, config, channel);
  class BoundModelProxyProvider extends ModelProxyProvider {
    static inputExcludesCache = inputExcludesCache;
  }
  return new BoundModelProxyProvider(name, config, channel);
}

// The PC's provider set (availability + non-secret config) changes only on a
// PC-side sign-in or settings edit; a short cache keeps registry re-inits from
// paying a client round trip each. The cache belongs to one client generation:
// a reconnect (possibly from another PC) always asks again.
const PROVIDER_CONFIG_TTL_MS = 15_000;
/** How long a registry init waits for a client to connect and for its PC to
 *  answer with a loaded provider registry. */
export const MODEL_PROXY_CONFIG_WAIT_MS = 15_000;
const CONFIG_RETRY_FIRST_MS = 250;
const CONFIG_RETRY_MAX_MS = 2_000;
let _providerConfigCache = null;
let _providerConfigInFlight = null;

/** A reply the registry may act on: the PC says its registry is loaded, or it
 *  already names an enabled provider (a client that predates `ready`). An
 *  empty or unready answer is never read as "everything disabled". */
function providerConfigReady(reply, providers) {
  // A loaded PC registry is authoritative, even when it has nothing enabled.
  if (reply?.ready === true) return true;
  if (reply?.ready === false) return false;
  return Object.keys(providers).some((name) => providers[name]?.enabled === true);
}

const pause = (ms) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });

export function loadModelProxyProviderConfig({
  channel = getModelProxyChannel(),
  now = Date.now,
  waitMs = MODEL_PROXY_CONFIG_WAIT_MS,
  force = false,
} = {}) {
  const generation = channel.generation;
  const cached = _providerConfigCache;
  if (
    !force &&
    cached &&
    cached.channel === channel &&
    cached.generation === generation &&
    now() - cached.at < PROVIDER_CONFIG_TTL_MS
  ) {
    return Promise.resolve(cached.value);
  }
  const inFlight = _providerConfigInFlight;
  // A forced read starts after the caller's change, never reuses an older
  // snapshot. Short setup reads also cannot inherit a registry init's budget.
  if (
    !force &&
    inFlight &&
    inFlight.channel === channel &&
    inFlight.generation === generation &&
    inFlight.waitMs === waitMs
  )
    return inFlight.promise;
  const promise = (async () => {
    const deadline = Date.now() + waitMs;
    let delay = CONFIG_RETRY_FIRST_MS;
    let lastError = null;
    for (;;) {
      if (!channel.connected) {
        const remaining = deadline - Date.now();
        if (remaining <= 0 || !(await channel.whenConnected(remaining))) {
          throw lastError ?? new ModelProxyUnavailableError('no desktop client is connected to run model calls');
        }
      }
      try {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new ModelProxyUnavailableError('the desktop provider request timed out');
        const controller = new AbortController();
        const timer = setTimeout(
          () => controller.abort(new ModelProxyUnavailableError('the desktop provider request timed out')),
          remaining
        );
        timer.unref?.();
        let reply;
        try {
          reply = await channel.request({ provider: '', method: 'providerConfig' }, { signal: controller.signal });
        } finally {
          clearTimeout(timer);
        }
        const raw = reply?.providers && typeof reply.providers === 'object' ? reply.providers : {};
        // Defense in depth: the PC already strips secrets before sending.
        const value = stripModelProxySecrets(raw);
        if (providerConfigReady(reply, value)) {
          // An older read may finish after a forced refresh; only the newest
          // request may publish to the shared cache.
          if (channel.generation === generation && _providerConfigInFlight === entry) {
            _providerConfigCache = { at: now(), value, channel, generation };
          }
          return value;
        }
        lastError = new ModelProxyUnavailableError('the desktop client has not loaded its model providers yet');
      } catch (error) {
        // Only "no client / no answer yet" is worth waiting out.
        if (error?.code !== 'MODEL_PROXY_UNAVAILABLE') throw error;
        lastError = error;
      }
      if (Date.now() + delay > deadline) throw lastError;
      await pause(delay);
      delay = Math.min(delay * 2, CONFIG_RETRY_MAX_MS);
    }
  })();
  const entry = { channel, generation, waitMs, promise };
  _providerConfigInFlight = entry;
  const clear = () => {
    if (_providerConfigInFlight === entry) _providerConfigInFlight = null;
  };
  promise.then(clear, clear);
  return promise;
}

export function _resetModelProxyProviderConfigForTest() {
  _providerConfigCache = null;
  _providerConfigInFlight = null;
}
