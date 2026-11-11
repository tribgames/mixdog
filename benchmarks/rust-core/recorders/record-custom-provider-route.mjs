#!/usr/bin/env node
// custom-provider-route.test.mjs (1 case): the real default-provider and route resolvers over a saved config whose validator receives the
// config. The validator is the product's injected callback (the test's own stub: a custom type check); its arguments are recorded.
//   node benchmarks/rust-core/recorders/record-custom-provider-route.mjs --tree <exact export of b6f10295a>
import { startRecording } from './lib/provider-case-recorder.mjs';

const rec = await startRecording({
  recorderUrl: import.meta.url,
  set: 'provider-custom-provider-route',
  net: false,
  entry: 'src/runtime/agent/orchestrator/runtime-core/config-helpers.mjs makeResolveDefaultProvider(validate)(config) and makeResolveRoute(resolve)(config, { model }). The validator is the test\'s callback (providers[id].type === "custom"); the recorder records the arguments it received.',
  compare: 'mixdog-ai service::admin_route (admin_route.rs:286): the validator receives the saved config; compare `result.defaultProvider` and `result.routeProvider`, and `validatorCalls` (provider id, whether the config passed is the same object as the input).',
  replay: "Rust entry (pub, on o1): mixdog_ai::service::admin_route::resolve_route (service/admin_route.rs:311).",
});
const { makeResolveDefaultProvider, makeResolveRoute } = await rec.P('agent/orchestrator/runtime-core/config-helpers.mjs');
const SRC = 'src/runtime/agent/orchestrator/runtime-core/custom-provider-route.test.mjs';
const config = { default: 'main', presets: [{ id: 'main', provider: 'custom-test', model: 'm1' }], providers: { 'custom-test': { type: 'custom', enabled: true } } };
await rec.run('default-provider-validation-gets-saved-config', `${SRC}:5`, { config }, () => {
  const validatorCalls = [];
  const resolve = makeResolveDefaultProvider((id, current) => {
    validatorCalls.push({ id, sameConfigObject: current === config });
    return current.providers[id]?.type === 'custom';
  });
  return { defaultProvider: resolve(config), routeProvider: makeResolveRoute(resolve)(config, { model: 'm2' }).provider, validatorCalls };
});
await rec.finish();
