// Child of record.mjs: Node's OAuth provider in the isolated env it was started in. The fetch of api.anthropic.com goes to
// the loopback stand-in; every other host the metadata layers would reach stays blocked (model-lists/offline.mjs).
//   node --experimental-transform-types child.mjs <nodeTree> <stubOrigin>
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [nodeTree, stubOrigin] = process.argv.slice(2);
const trueFetch = globalThis.fetch;
await import(pathToFileURL(join(import.meta.dirname, '..', 'model-lists', 'offline.mjs')).href);
const blocked = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  return url.hostname === 'api.anthropic.com' ? trueFetch(`${stubOrigin}${url.pathname}${url.search}`, init) : blocked(input, init);
};
const at = (path) => import(pathToFileURL(join(nodeTree, 'src', 'runtime', 'agent', 'orchestrator', 'providers', path)).href);
const { AnthropicOAuthProvider } = await at('anthropic-oauth.mjs');
const { flushModelCacheWrites } = await at('model-cache.mjs');
const provider = new AnthropicOAuthProvider({});
const first = await provider.listModels();
await flushModelCacheWrites();
const second = await provider.listModels();
await flushModelCacheWrites();
const cacheFile = JSON.parse(readFileSync(join(process.env.MIXDOG_DATA_DIR, 'anthropic-oauth-models.json'), 'utf8'));
// What a session sized from the roster file reads (`cachedRouteWindows` inside `resolveRouteContextState`): the route's
// context state for models the file lists, one asked by an undated alias, one it does not list, and a provider with no roster.
const { resolveRouteContextState } = await import(pathToFileURL(join(nodeTree, 'src', 'runtime', 'agent', 'orchestrator', 'runtime-core', 'route-context-state.mjs')).href);
const routes = [
  { provider: 'anthropic-oauth', model: 'claude-opus-4-8' },
  { provider: 'anthropic', model: 'claude-sonnet-4-6' },
  { provider: 'anthropic-oauth', model: 'claude-haiku-4-5-20251001' },
  { provider: 'anthropic-oauth', model: 'claude-sonnet-4-6-20260101' },
  { provider: 'anthropic-oauth', model: 'claude-mystery-4-9' },
  { provider: 'anthropic-oauth', model: 'claude-missing' },
  { provider: 'openai', model: 'gpt-5.5' },
];
const routeStates = routes.map((route) => ({ route, state: resolveRouteContextState(route, null) }));
console.log(`RESULT ${JSON.stringify({ first, second, cacheFile, routeStates })}`);
process.exit(0);
