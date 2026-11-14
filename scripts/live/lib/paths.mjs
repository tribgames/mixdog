// Where a live run finds its inputs. Nothing is hard-coded: the core binary and the isolated root come from the command
// line or the environment, the rest is derived from this checkout.
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { desktopOrtLibraryPath, onnxRuntimeSupported, ortBinaryDir } from '../../../apps/desktop/scripts/core-layout.mjs';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const DESKTOP_DIR = join(REPO_ROOT, 'apps', 'desktop');
/** The custom provider id the scripted endpoint is configured under (a UUID-shaped id, as the app writes them). */
export const CUSTOM = 'custom-11111111-1111-4111-8111-111111111111';
export const INSTANCE_NAME = 'live';

/** `--name=value` and `--name value` options of a runner command line; a bare `--flag` is `true`. */
export function parseLiveArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(argv[i]);
    if (!m) continue;
    const [, key, inline] = m;
    if (inline !== undefined) out[key] = inline;
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) out[key] = argv[++i];
    else out[key] = true;
  }
  return out;
}

/** The ONNX Runtime library the dev core loads, or null where the target has none. */
export function findOrtLibrary({ desktopDir = DESKTOP_DIR, repoRoot = REPO_ROOT, platform = process.platform, arch = process.arch, exists = existsSync } = {}) {
  if (!onnxRuntimeSupported(platform, arch)) return null;
  const file = desktopOrtLibraryPath(platform, arch).split('/').pop();
  const rel = join('onnxruntime-node', ortBinaryDir(platform, arch), file);
  const candidates = [
    join(desktopDir, '.runtime', 'native-modules', rel),
    join(desktopDir, 'node_modules', rel),
    join(repoRoot, 'node_modules', rel),
  ];
  const found = candidates.find((candidate) => exists(candidate));
  if (!found) throw new Error(`onnxruntime library not found (tried ${candidates.join(', ')}); name one with --ort-library or MIXDOG_LIVE_ORT_LIBRARY`);
  return found;
}

/**
 * The paths of one run. `--core` / MIXDOG_LIVE_CORE_EXE names the built mixdogd (required); `--iso-root` /
 * MIXDOG_LIVE_ISO_ROOT is the instance root (default: a folder in the system temp dir); `--electron-dist` /
 * MIXDOG_LIVE_ELECTRON_DIST and `--ort-library` / MIXDOG_LIVE_ORT_LIBRARY override what this checkout provides.
 */
export function resolveLivePaths({ argv = process.argv.slice(2), env = process.env, exists = existsSync, platform = process.platform, arch = process.arch } = {}) {
  const args = parseLiveArgs(argv);
  const pick = (flag, name) => (typeof args[flag] === 'string' ? args[flag] : env[name] || undefined);
  const coreExe = pick('core', 'MIXDOG_LIVE_CORE_EXE');
  if (!coreExe) throw new Error('no core binary: pass --core=<mixdogd> or set MIXDOG_LIVE_CORE_EXE');
  if (!exists(resolve(coreExe))) throw new Error(`core binary does not exist: ${resolve(coreExe)}`);
  const isoRoot = resolve(pick('iso-root', 'MIXDOG_LIVE_ISO_ROOT') ?? join(tmpdir(), 'mixdog-live'));
  const electronDist = pick('electron-dist', 'MIXDOG_LIVE_ELECTRON_DIST');
  const dist = electronDist ?? join(DESKTOP_DIR, 'node_modules', 'electron', 'dist');
  return {
    repoRoot: REPO_ROOT,
    desktopDir: DESKTOP_DIR,
    coreExe: resolve(coreExe),
    isoRoot,
    electronDist: electronDist ? resolve(electronDist) : exists(dist) ? dist : undefined,
    ortLibrary: pick('ort-library', 'MIXDOG_LIVE_ORT_LIBRARY') ?? findOrtLibrary({ platform, arch, exists }),
    out: typeof args.out === 'string' ? resolve(args.out) : undefined,
    args,
  };
}
