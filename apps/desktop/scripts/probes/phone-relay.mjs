// Local-only relay for phone-layout checks: builds the CURRENT renderer into a
// temp folder and serves it from the repo's own relay on a free loopback port.
// The production relay is never contacted; an isolated instance dials THIS one
// via `dev:isolated -- --relay <relayUrl>` and a headless phone-emulated
// Chromium pairs against it (probes/phone-shot.mjs).
//
// Usage (from apps/desktop; keep it running in the background):
//   node scripts/probes/phone-relay.mjs --name <tag> [--skip-build]
// Prints one JSON line {"relayUrl","bundle","dataDir"}; stop it with Ctrl+C or
// by cancelling its task. Scratch lives in %TEMP%/<tag>/ (never apps/desktop/out).
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const desktopDir = fileURLToPath(new URL('../..', import.meta.url));
const { values } = parseArgs({ options: { name: { type: 'string' }, 'skip-build': { type: 'boolean' } } });
if (!/^[a-z0-9][a-z0-9-]{0,47}$/i.test(values.name ?? ''))
  throw new Error('--name <tag> is required (letters, digits, hyphens).');

const scratch = join(tmpdir(), values.name);
const bundle = join(scratch, 'bundle');
const dataDir = join(scratch, 'relay-data');
if (!values['skip-build']) {
  rmSync(bundle, { recursive: true, force: true });
  const build = spawnSync(
    process.execPath,
    [join(desktopDir, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js'), 'build', '--outDir', bundle],
    {
      cwd: desktopDir,
      stdio: ['ignore', 'ignore', 'inherit'],
      env: { ...process.env, MIXDOG_ELECTRON_BUILD_TARGETS: 'renderer' },
    }
  );
  if (build.status !== 0) throw new Error(`renderer build failed (${build.status}).`);
}
rmSync(dataDir, { recursive: true, force: true });
mkdirSync(dataDir, { recursive: true });

const { startRelay } = await import(pathToFileURL(join(desktopDir, '..', 'relay', 'server.mjs')).href);
const relay = await startRelay({ port: 0, dataDir, rendererDir: join(bundle, 'renderer') });
console.log(JSON.stringify({ relayUrl: `ws://127.0.0.1:${relay.port}`, bundle: join(bundle, 'renderer'), dataDir }));
const stop = () => relay.close().finally(() => process.exit(0));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
