#!/usr/bin/env node

import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  rename,
  rm,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  NATIVE_TOOL_FILENAMES,
  packageNativeToolsDir,
} from '../src/runtime/shared/native-tool-paths.mjs';
import { ensureGraphBinary } from '../src/runtime/agent/orchestrator/tools/graph-binary-fetcher.mjs';
import { ensurePatchBinary } from '../src/runtime/agent/orchestrator/tools/patch-binary-fetcher.mjs';
import { ensureSpawnBinary } from '../src/runtime/agent/orchestrator/tools/spawn-binary-fetcher.mjs';
import { ensureTokenAddon } from '../src/runtime/agent/orchestrator/tools/token-addon-fetcher.mjs';

const DEFAULT_PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const REQUIRED_NATIVE_INSTALLERS = Object.freeze({
  graph: ensureGraphBinary,
  patch: ensurePatchBinary,
  spawn: ensureSpawnBinary,
  token: ensureTokenAddon,
});

export async function prepareRequiredNativeAssets({
  packageRoot = DEFAULT_PACKAGE_ROOT,
  installers = REQUIRED_NATIVE_INSTALLERS,
} = {}) {
  const root = resolve(String(packageRoot || ''));
  const target = packageNativeToolsDir(root);
  const stagingRoot = await mkdtemp(join(root, '.native-tools-install-'));
  const downloadDataDir = join(stagingRoot, 'downloads');
  const stagedToolsDir = join(stagingRoot, 'native-tools');
  try {
    await mkdir(stagedToolsDir, { recursive: true });
    const entries = await Promise.all(
      Object.entries(NATIVE_TOOL_FILENAMES).map(async ([name, fileName]) => {
        const install = installers[name];
      if (typeof install !== 'function') {
        throw new Error(`native asset installer is invalid: ${name}`);
      }
        const installedPath = await install(downloadDataDir);
      if (typeof installedPath !== 'string' || installedPath.length === 0) {
        throw new Error(`native asset installer returned no path: ${name}`);
      }
        const destination = join(stagedToolsDir, fileName);
        await copyFile(installedPath, destination);
        if (process.platform !== 'win32' && name !== 'token') {
          await chmod(destination, 0o755);
        }
        return [name, join(target, fileName)];
      }),
    );
    await rm(target, {
      recursive: true,
      force: true,
      maxRetries: 8,
      retryDelay: 100,
    });
    await rename(stagedToolsDir, target);
    return Object.fromEntries(entries);
  } finally {
    // Antivirus and process scanners can briefly retain freshly copied .exe
    // handles on Windows. Cleanup must not replace the installer's real error
    // with a transient EBUSY from the staging directory.
    await rm(stagingRoot, {
      recursive: true,
      force: true,
      maxRetries: 8,
      retryDelay: 100,
    });
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  try {
    const prepared = await prepareRequiredNativeAssets();
    console.log(`[native-assets] ready: ${Object.keys(prepared).join(', ')}`);
  } catch (error) {
    console.error(`[native-assets] install failed: ${error?.message || String(error)}`);
    process.exitCode = 1;
  }
}
