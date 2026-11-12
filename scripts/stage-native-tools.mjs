#!/usr/bin/env node
// Stages the pinned graph, patch and spawn tools of this machine into `<repo>/native-tools/`, where the core and the
// Node tests look for the package's own tools (mixdog-core run_host/native_tools.rs, `Step::Package`). An install used
// to do this in `postinstall`, which now only prunes the embedding runtime, so a CI job that runs against the checkout
// calls this after `npm ci`. The download is the pinned one of `scripts/native-tool-download.mjs`: its manifest, its URL
// rule and its sha256 check.
import { chmod, copyFile, mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { downloadNativeTool, NATIVE_TOOL_PLATFORM_KEYS, nativeToolInstalledName } from './native-tool-download.mjs';

export const STAGED_NATIVE_TOOL_KINDS = Object.freeze(['graph', 'patch', 'spawn']);

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** @returns {Promise<string[]>} the staged files */
export async function stageNativeTools({
  root = DEFAULT_ROOT,
  platform = process.platform,
  arch = process.arch,
  download = downloadNativeTool,
} = {}) {
  const key = `${platform}-${arch}`;
  if (!NATIVE_TOOL_PLATFORM_KEYS.includes(key)) {
    throw new Error(`native tools are not published for ${key}; supported: ${NATIVE_TOOL_PLATFORM_KEYS.join(', ')}`);
  }
  const target = { platform, arch };
  const cacheDir = join(root, '.native-tools-install-cache');
  const toolsDir = join(root, 'native-tools');
  await rm(toolsDir, { recursive: true, force: true });
  await mkdir(toolsDir, { recursive: true });
  const staged = [];
  for (const kind of STAGED_NATIVE_TOOL_KINDS) {
    const downloaded = await download(kind, target, cacheDir);
    const destination = join(toolsDir, nativeToolInstalledName(kind, target));
    await copyFile(downloaded, destination);
    if (platform !== 'win32') await chmod(destination, 0o755);
    staged.push(destination);
  }
  return staged;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    for (const file of await stageNativeTools()) console.log(`[stage-native-tools] ${file}`);
  } catch (error) {
    console.error(`[stage-native-tools] failed: ${error.message}`);
    process.exitCode = 1;
  }
}