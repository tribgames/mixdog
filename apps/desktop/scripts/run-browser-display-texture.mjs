import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import electron from 'electron';
import { build } from 'esbuild';

const directory = await mkdtemp(join(tmpdir(), 'mixdog-display-texture-'));
await Promise.all([
  build({
    entryPoints: [fileURLToPath(new URL('../src/main/browser/display-texture.integration.ts', import.meta.url))],
    outfile: join(directory, 'main.mjs'), bundle: true, platform: 'node', format: 'esm',
    external: ['electron'], logLevel: 'warning',
  }),
  build({
    entryPoints: [fileURLToPath(new URL('../src/main/browser/test-fixtures/display-texture-preload.ts', import.meta.url))],
    outfile: join(directory, 'preload.cjs'), bundle: true, platform: 'node', format: 'cjs',
    external: ['electron'], logLevel: 'warning',
  }),
]);
const env = { ...process.env, MIXDOG_TEXTURE_DIRECTORY: directory };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, [join(directory, 'main.mjs')], { env, stdio: 'inherit', windowsHide: true });
const code = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => child.kill(), 25000);
  child.once('error', error => { clearTimeout(timer); reject(error); });
  child.once('exit', code => { clearTimeout(timer); resolve(code); });
});
console.log(`Texture probe artifacts retained: ${directory}`);
if (code !== 0) throw new Error(`Shared texture probe failed (exit ${code})`);
