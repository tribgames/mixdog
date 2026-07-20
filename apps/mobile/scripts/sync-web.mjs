// Copies the built desktop renderer into the Capacitor webDir. The mobile
// shell ships the SAME UI bundle the desktop uses; remote-shim.ts detects the
// native shell and drives everything over the remote-bridge WebSocket.
import { cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const rendererDist = join(root, '..', 'desktop', 'out', 'renderer');
const webDir = join(root, 'www');

if (!existsSync(join(rendererDist, 'index.html'))) {
  console.error('[mobile] renderer build not found. Run `npm run build` in apps/desktop first.');
  process.exit(1);
}
rmSync(webDir, { recursive: true, force: true });
cpSync(rendererDist, webDir, { recursive: true });
console.log(`[mobile] synced renderer -> ${webDir}`);
