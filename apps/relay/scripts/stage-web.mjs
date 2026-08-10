// Stage the built desktop renderer beside the relay for web-app deployment.
import { cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const relayRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const rendererDist = join(relayRoot, '..', 'desktop', 'out', 'renderer');
const webDir = join(relayRoot, 'renderer');

if (!existsSync(join(rendererDist, 'index.html'))) {
  console.error('[relay] renderer build not found. Run `npm run build` in apps/desktop first.');
  process.exit(1);
}
rmSync(webDir, { recursive: true, force: true });
cpSync(rendererDist, webDir, { recursive: true });
console.log(`[relay] staged web app -> ${webDir}`);
