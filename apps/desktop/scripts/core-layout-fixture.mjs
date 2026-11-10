// A complete install of the core's JS runtime on disk, built from core-layout.mjs's own description, for the
// packaging tests (core-layout, verify-staged-package).
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { makeTempDirSync } from '../../../scripts/lib/scoped-temp.mjs';
import { CLOSURE_RECORD, CORE_READS, desktopJsRuntimeManifest, ortBinaryDir, remoteJsRuntimeManifest } from './core-layout.mjs';

export const put = (file, text = 'x') => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
};

export const LIBRARY = { win32: 'onnxruntime.dll', linux: 'libonnxruntime.so.1', darwin: 'libonnxruntime.1.dylib' };
const SIBLINGS = {
  win32: ['onnxruntime_binding.node', 'DirectML.dll', 'msvcp140.dll', 'msvcp140_1.dll', 'msvcp140_atomic_wait.dll', 'vcruntime140.dll', 'vcruntime140_1.dll'],
  linux: ['onnxruntime_binding.node'],
  darwin: ['onnxruntime_binding.node'],
};

/** A `node_modules` holding the package (the files and directories the core reads, an ext host reaching `alpha`,
 *  which depends on `beta`) and, where the platform has one, the ONNX Runtime directory. */
export function modulesTree(modules, platform, arch) {
  const mixdog = join(modules, 'mixdog');
  for (const file of CORE_READS.files) put(join(mixdog, file), file.endsWith('.json') ? '{}' : '');
  put(join(mixdog, 'src/ext-host/worker.mjs'), "import 'alpha';\n");
  put(join(mixdog, 'src/skill-script-entry.mjs'), '');
  for (const dir of CORE_READS.dirs) put(join(mixdog, dir, 'file.md'));
  put(join(modules, 'alpha/package.json'), JSON.stringify({ name: 'alpha', dependencies: { beta: '1' } }));
  put(join(modules, 'beta/package.json'), JSON.stringify({ name: 'beta' }));
  put(join(modules, CLOSURE_RECORD), JSON.stringify({ skippedOptional: [] }));
  if (platform === 'darwin' && arch === 'x64') return;
  const binary = join(modules, 'onnxruntime-node', ortBinaryDir(platform, arch));
  put(join(binary, LIBRARY[platform]));
  for (const sibling of SIBLINGS[platform]) put(join(binary, sibling));
}

/** `resources/` of a desktop package or `payload/` of a server bundle, complete for `platform`/`arch`. A desktop's
 *  resources sit one level inside its app directory: the interpreter is `../../<app>` of core/. `top` is the
 *  directory it is built in (a fresh temporary one by default; the remote payload is `top` itself). */
export function install(kind, platform, arch, top = makeTempDirSync(`core-layout-${kind}`)) {
  const root = kind === 'desktop' ? join(top, 'resources') : top;
  const manifest = (kind === 'desktop' ? desktopJsRuntimeManifest : remoteJsRuntimeManifest)(platform, arch);
  const dir = kind === 'desktop' ? join(root, 'core') : root;
  put(join(dir, 'js-runtime.json'), JSON.stringify(manifest));
  put(join(dir, manifest.program));
  const modules = kind === 'desktop' ? join(root, 'runtime.asar.unpacked/node_modules') : join(root, 'js/pkg/node_modules');
  modulesTree(modules, platform, arch);
  return { root, dir, modules, top };
}
