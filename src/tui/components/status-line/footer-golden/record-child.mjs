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
const settle = async () => {
  await new Promise((resolve) => setImmediate(resolve));
  // The route-meta module of the limits loads by dynamic import; the next render is far later than that.
  await new Promise((resolve) => setTimeout(resolve, 100));
};

if (steps) {
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
  const meta = await import(pathToFileURL(join(process.env.FOOTER_TREE, 'src', 'runtime', 'agent', 'orchestrator', 'providers', 'statusline-route-meta.mjs')).href);
  try {
    meta.buildGatewayLimits({});
  } catch {
    /* loading */
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
  // The footer refreshes its quota caches off the render call; the settled text is the one recorded.
  let text = '';
  for (let i = 0; i < 6; i += 1) {
    text = await renderStatusline(args);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  process.stdout.write(JSON.stringify(text));
}
process.exit(0);
