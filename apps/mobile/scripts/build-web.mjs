// Builds the bundled shell page (QR / paste pairing screen) into www/. The UI
// after pairing is NOT bundled: the WebView navigates to the relay.
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const out = join(root, 'www');

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'assets'), { recursive: true });
await build({
  entryPoints: [join(root, 'src', 'main.ts')],
  outfile: join(out, 'assets', 'main.js'),
  bundle: true,
  format: 'esm',
  target: ['es2022', 'safari15', 'chrome100'],
  minify: true,
  logLevel: 'info',
  // Verification builds pair against a staging relay; release builds leave it
  // empty and use the production relay.
  define: { __MIXDOG_RELAY_ORIGIN__: JSON.stringify(process.env.MIXDOG_MOBILE_RELAY_ORIGIN || '') },
});
cpSync(join(root, 'src', 'index.html'), join(out, 'index.html'));
cpSync(join(root, '..', 'desktop', 'src', 'renderer', 'public', 'mixdog.svg'), join(out, 'mixdog.svg'));
cpSync(join(root, '..', '..', 'design', 'brand', 'mixdog-logo-b.svg'), join(out, 'mixdog-logo-titanium.svg'));
console.log(`[mobile] built shell -> ${out}`);
