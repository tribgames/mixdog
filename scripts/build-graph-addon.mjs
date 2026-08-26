// Builds the in-process search engine addon and names it the way the runtime
// resolver expects (`mixdog-graph.node`). Mirrors build-token-addon.mjs; the
// cdylib cargo emits is a plain `.dll`/`.dylib`/`.so`, which Node's loader
// refuses by extension, so the copy is the build step's whole point.
import { copyFile, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = join(root, 'native', 'mixdog-graph-addon', 'Cargo.toml');
const release = process.argv.includes('--release');
const profile = release ? 'release' : 'debug';
const sourceName = process.platform === 'win32'
  ? 'mixdog_graph_addon.dll'
  : process.platform === 'darwin' ? 'libmixdog_graph_addon.dylib' : 'libmixdog_graph_addon.so';
const target = join(root, 'native', 'mixdog-graph-addon', 'target', profile);
const source = join(target, sourceName);
const destination = join(target, 'mixdog-graph.node');

if (process.argv.includes('--build')) {
  const args = ['build', '--locked', '--manifest-path', manifest];
  if (release) args.splice(1, 0, '--release');
  const child = spawn('cargo', args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
  const code = await new Promise((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', (value, signal) => {
      if (signal) reject(new Error(`cargo build terminated by ${signal}`));
      else resolveExit(value ?? 1);
    });
  });
  if (code !== 0) process.exit(code);
}

await mkdir(dirname(destination), { recursive: true });
await copyFile(source, destination);
process.stdout.write(`${destination}\n`);
