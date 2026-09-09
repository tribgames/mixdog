import { spawn } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Generate an isolated build workspace. Never clean or modify the prepared
// dependency checkout, the user's browser profile, or the packaged importer.
const source = fileURLToPath(new URL('.', import.meta.url));
const revision = '6e2c2151f215df69b7cf75b43f189b2cba8b6b5e';
const nativeRoot = resolve(process.argv[2] || join(
  tmpdir(), `mixdog-browser-import-${revision}`, 'apps', 'desktop', 'desktop_native',
));
const staging = await mkdtemp(join(tmpdir(), 'mixdog-cookie-tests-'));
try {
  const manifest = (await readFile(join(source, 'Cargo.toml'), 'utf8')).replace(
    'path = "../chromium_importer"',
    `path = ${JSON.stringify(join(nativeRoot, 'chromium_importer').replaceAll('\\', '/'))}`,
  );
  await cp(join(source, 'src'), join(staging, 'src'), { recursive: true });
  await writeFile(join(staging, 'Cargo.toml'), manifest);
  const child = spawn('cargo', ['test', '--manifest-path', join(staging, 'Cargo.toml')], {
    stdio: 'inherit',
    windowsHide: true,
    env: {
      ...process.env,
      CARGO_TARGET_DIR: process.env.CARGO_TARGET_DIR || join(tmpdir(), 'mx-bi-cookie-tests'),
    },
  });
  const code = await new Promise((resolveCode, reject) => {
    child.once('error', reject);
    child.once('exit', (status, signal) => {
      if (signal) reject(new Error(`Native cookie tests terminated by ${signal}`));
      else resolveCode(status ?? 1);
    });
  });
  if (code !== 0) throw new Error(`Native cookie tests failed (exit ${code})`);
} finally {
  await rm(staging, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
