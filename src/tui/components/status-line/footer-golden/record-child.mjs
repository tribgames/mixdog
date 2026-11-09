import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const { renderStatusline } = await import(pathToFileURL(join(process.env.FOOTER_TREE, 'src', 'ui', 'statusline.mjs')).href);
const args = JSON.parse(process.env.FOOTER_ARGS);
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
process.exit(0);
