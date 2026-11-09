// Node's own model-list path (session-runtime/provider-models.mjs `collectProviderModels`) with a provider whose
// `listModels` enriches its rows through the pricing catalogs, as the real providers do. The footer is rendered
// before the list call, right after the quick call resolves (its background load held open by a gate) and after the
// full call — which joins and awaits that load — resolves.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const tree = process.env.FOOTER_TREE;
const url = (path) => pathToFileURL(join(tree, path)).href;
// The catalogs load from the data dir: the remote fetch is refused, which is the disk fallback of the real load.
globalThis.fetch = async () => {
  throw new Error('offline');
};
const { renderStatusline } = await import(url('src/ui/statusline.mjs'));
const { enrichModels } = await import(url('src/runtime/agent/orchestrator/providers/model-catalog.mjs'));
const { createProviderModels } = await import(url('src/session-runtime/provider-models.mjs'));
const args = JSON.parse(process.env.FOOTER_ARGS);

let open;
const gate = new Promise((resolve) => {
  open = resolve;
});
const provider = {
  async listModels() {
    await gate;
    return enrichModels([{ id: args.model, provider: args.provider }]);
  },
};
const registry = {
  providerCatalogRevision: () => 1,
  getAllProviders: () => new Map([[args.provider, provider]]),
  getProvider: () => provider,
};
const caches = {
  providerModelsLoadSeq: 0,
  providerModelsCache: { models: null, at: 0 },
  providerModelsPromise: null,
  webSearchProviderModelsCache: { models: null, at: 0 },
};
const api = createProviderModels({
  caches,
  modelMetaByRoute: new Map(),
  getRoute: () => ({ provider: args.provider }),
  getConfig: () => ({ providers: { [args.provider]: { enabled: true } } }),
  getReg: () => registry,
  webSearchCapableFor: () => false,
  sortProviderModelsRaw: (rows) => rows,
  providerModelCacheRowRaw: (name, model) => ({ ...model, provider: name }),
  normalizeWebSearchProviderId: (name) => name,
  isWebSearchCapableProvider: () => false,
  ensureFullConfig: () => ({}),
  awaitKeychainPrewarm: async () => {},
  ensureProvidersReady: async () => {},
  bootProfile() {},
  scheduleProviderModelWarmup() {},
  quickHelpers: { quickProviderModelRows: () => [] },
});

const texts = [];
texts.push(await renderStatusline(args));
await api.collectProviderModels({ quick: true });
texts.push(await renderStatusline(args));
open();
await api.collectProviderModels({});
texts.push(await renderStatusline(args));
process.stdout.write(JSON.stringify(texts));
process.exit(0);
