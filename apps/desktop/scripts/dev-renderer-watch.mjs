import { mkdir, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveConfig } from 'electron-vite';
import { build as viteBuild } from 'vite';
import { resolveRendererWatchIdleMs } from './dev-renderer-watch-config.mjs';

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const configPath = join(desktopDir, 'electron.vite.config.ts');
const args = Object.fromEntries(process.argv.slice(2).map((entry) => {
  const match = /^--([^=]+)=(.*)$/s.exec(entry);
  return match ? [match[1], match[2]] : [entry.replace(/^--/, ''), true];
}));
const statePath = resolve(args.state || join(desktopDir, '.cache', 'dev-renderer-watch.json'));
// Keep the warm incremental compiler briefly for rapid consecutive deploys,
// then release its large module graph instead of retaining ~1.8 GB for 30 min.
const idleMs = resolveRendererWatchIdleMs(args['idle-ms']);
const configMtimeMs = (await stat(configPath)).mtimeMs;

let watcher = null;
let generation = 0;
let idleTimer = null;
let closing = false;
let stateWrites = Promise.resolve();

function publish(status, detail = '') {
  const record = {
    schemaVersion: 1,
    pid: process.pid,
    status,
    detail,
    generation,
    configMtimeMs,
    at: new Date().toISOString(),
  };
  stateWrites = stateWrites.then(async () => {
    await mkdir(dirname(statePath), { recursive: true });
    const temporary = `${statePath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`);
    await rename(temporary, statePath);
  }).catch(() => {});
  return stateWrites;
}

async function close(reason, exitCode = 0) {
  if (closing) return;
  closing = true;
  if (idleTimer) clearTimeout(idleTimer);
  try {
    await watcher?.close();
  } finally {
    await publish(exitCode ? 'error' : 'stopped', reason);
    process.exit(exitCode);
  }
}

process.once('SIGINT', () => void close('SIGINT'));
process.once('SIGTERM', () => void close('SIGTERM'));
process.once('uncaughtException', (error) => void close(error?.stack || String(error), 1));
process.once('unhandledRejection', (error) => void close(error?.stack || String(error), 1));

await publish('starting');

try {
  process.env.NODE_ENV_ELECTRON_VITE = 'production';
  process.env.MIXDOG_ELECTRON_BUILD_TARGETS = 'renderer';
  const resolved = await resolveConfig(
    { root: desktopDir, mode: 'production', logLevel: 'info', clearScreen: false },
    'build',
    'production',
  );
  const renderer = resolved.config?.renderer;
  if (!renderer) throw new Error('electron-vite did not resolve a renderer build config');
  renderer.build = { ...renderer.build, watch: {} };
  watcher = await viteBuild(renderer);
  if (!watcher || typeof watcher.on !== 'function') {
    throw new Error('Vite did not return a production build watcher');
  }
  watcher.on('event', (event) => {
    if (event.code === 'START') void publish('building');
    if (event.code === 'ERROR') void publish('error', event.error?.stack || String(event.error));
    if (event.code !== 'END') return;
    generation += 1;
    void publish('ready');
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => void close('idle timeout'), idleMs);
    idleTimer.unref();
  });
} catch (error) {
  await publish('error', error?.stack || String(error));
  process.exit(1);
}
