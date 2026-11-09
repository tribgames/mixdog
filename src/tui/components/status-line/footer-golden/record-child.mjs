import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const { renderStatusline } = await import(pathToFileURL(join(process.env.FOOTER_TREE, 'src', 'ui', 'statusline.mjs')).href);
const args = JSON.parse(process.env.FOOTER_ARGS);
if (process.env.FOOTER_WARM) {
  // A model list was loaded (the picker, the boot prefetch): the pricing catalogs are resident, read from the data dir.
  const { warmCatalogFromDisk } = await import(pathToFileURL(join(process.env.FOOTER_TREE, 'src', 'runtime', 'shared', 'llm', 'model-catalog.mjs')).href);
  await warmCatalogFromDisk();
}
const steps = process.env.FOOTER_STEPS ? JSON.parse(process.env.FOOTER_STEPS) : null;
const T0 = Number(process.env.FOOTER_T0);
const routeMetaUrl = pathToFileURL(join(process.env.FOOTER_TREE, 'src', 'vendor', 'statusline', 'src', 'gateway', 'route-meta.mjs')).href;
// Node's own completion signals: the dynamic import the limits module started (the same module-map promise, so it
// settles after the footer's own `.then`), then every refresh the footer deferred to setImmediate having run.
const settle = async () => {
  await import(routeMetaUrl);
  await globalThis.__footerIdle();
};
// The footer is stale-while-revalidate: a render returns the cached values and schedules the refreshes it needs, and
// some depend on an earlier one (the OAuth arm check gates the quota segment). Each render therefore waits for the
// refreshes it scheduled to complete (the signal above). The settled text is the render after which no new tracked
// operation (setImmediate or fs/promises call) has started: the dependent-refresh chain is finite, and there is
// deliberately no iteration cap.
const settledText = async () => {
  globalThis.__footerNewStage();
  for (;;) {
    await settle();
    const before = globalThis.__footerOperations();
    const text = await renderStatusline(args);
    if (globalThis.__footerOperations() === before) return text;
  }
};
const startRouteMetaLoad = async () => {
  // buildGatewayLimits throws until its route-meta module has loaded; the first call starts that load.
  const meta = await import(pathToFileURL(join(process.env.FOOTER_TREE, 'src', 'runtime', 'agent', 'orchestrator', 'providers', 'statusline-route-meta.mjs')).href);
  try {
    meta.buildGatewayLimits({});
  } catch {
    /* loading */
  }
  await settle();
};

const stages = process.env.FOOTER_STAGES ? JSON.parse(process.env.FOOTER_STAGES) : null;

if (stages) {
  // One footer across changes to the event store: each stage applies its change, moves the clock on and renders the settled text.
  const { applyStage } = await import(new URL('./scenarios.mjs', import.meta.url).href);
  await startRouteMetaLoad();
  const texts = [];
  for (const [index, stage] of stages.entries()) {
    applyStage(process.env.MIXDOG_DATA_DIR, stage);
    globalThis.__footerSetNow(T0 + 1000 * index);
    texts.push(await settledText());
  }
  process.stdout.write(JSON.stringify(texts));
} else if (steps) {
  // The first renders of a footer: what it shows at each of the clock offsets, refreshes running between them.
  const texts = [];
  for (const advance of steps) {
    globalThis.__footerSetNow(T0 + advance);
    texts.push(await renderStatusline(args));
    await settle();
  }
  process.stdout.write(JSON.stringify(texts));
} else {
  // buildGatewayLimits throws until its route-meta module has loaded; the first call starts that load, so the
  // footer is steady one refresh later. Start it here so the recorded text is the steady one.
  await startRouteMetaLoad();
  // The footer refreshes its quota caches off the render call; the settled text is the one recorded.
  process.stdout.write(JSON.stringify(await settledText()));
}
process.exit(0);
