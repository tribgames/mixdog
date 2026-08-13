import { copyFile, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = join(root, 'native', 'mixdog-token', 'Cargo.toml');
const release = process.argv.includes('--release');
const profile = release ? 'release' : 'debug';
const sourceName = process.platform === 'win32'
  ? 'mixdog_token.dll'
  : process.platform === 'darwin' ? 'libmixdog_token.dylib' : 'libmixdog_token.so';
const source = join(root, 'native', 'mixdog-token', 'target', profile, sourceName);
const destination = join(root, 'native', 'mixdog-token', 'target', profile, 'mixdog-token.node');

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
