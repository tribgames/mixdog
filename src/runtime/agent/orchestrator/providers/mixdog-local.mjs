import {
  ensureLocalProviderServer,
  installedLocalProviderModels,
  localProviderStatus,
} from '../../../local-provider/managed-runtime.mjs';
import { OpenAICompatProvider } from './openai-compat.mjs';
import { toLocalProviderMessages } from './mixdog-local-wire.mjs';
import { runLocalProviderRequest } from '../../../local-provider/server.mjs';
import { localProviderModelEntry } from '../../../local-provider/catalog.mjs';
import { assertLocalModelInput } from '../../../local-provider/input-capabilities.mjs';
import { beginLocalInference, localModelState } from '../../../local-provider/model-state.mjs';

export class MixdogLocalProvider {
  static inputExcludesCache = false;

  constructor(config = {}, { ensureServer = ensureLocalProviderServer, runRequest = runLocalProviderRequest } = {}) {
    this.name = 'mixdog-local';
    this.config = config;
    this._ensureServer = ensureServer;
    this._runRequest = runRequest;
    this.defaultModel = '';
    this._inner = null;
    this._innerKey = '';
  }

  async _providerFor(model, signal) {
    const endpoint = await this._ensureServer(model, { signal });
    const key = `${endpoint.baseURL}|${endpoint.apiKey}`;
    if (!this._inner || this._innerKey !== key) {
      this._inner = new OpenAICompatProvider(this.name, {
        ...this.config,
        baseURL: endpoint.baseURL,
        apiKey: endpoint.apiKey,
        preconnect: false,
      });
      this._innerKey = key;
    }
    return this._inner;
  }

  async send(messages, model, tools, sendOpts) {
    const signal = sendOpts?.signal;
    signal?.throwIfAborted();
    const entry = localProviderModelEntry(model) || { id: model, name: model };
    assertLocalModelInput(entry, messages, tools, sendOpts, localModelState(model).capabilities);
    const wireMessages = toLocalProviderMessages(messages);
    const queuedAt = performance.now();
    return this._runRequest(async (requestSignal) => {
      const measurement = beginLocalInference(model, queuedAt);
      try {
        const provider = await this._providerFor(model, requestSignal);
        requestSignal.throwIfAborted();
        assertLocalModelInput(entry, messages, tools, sendOpts, localModelState(model).capabilities);
        const result = await provider.send(wireMessages, model, tools, {
          ...sendOpts, signal: requestSignal,
          onStreamDelta: (kind) => { measurement.progress(kind); sendOpts?.onStreamDelta?.(kind); },
        });
        measurement.finish(result);
        return result;
      } catch (error) {
        measurement.finish(null, error);
        throw error;
      }
    }, { signal, onStageChange: sendOpts?.onStageChange });
  }

  async listModels() {
    return installedLocalProviderModels();
  }

  async isAvailable() {
    const status = localProviderStatus();
    return status.runtime.installed && status.models.some((model) => model.installed);
  }

  getCachedModelInfo(model) {
    return installedLocalProviderModels().find((entry) => entry.id === model) || null;
  }
}
