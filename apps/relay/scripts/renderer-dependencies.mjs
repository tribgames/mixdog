// Follow local imports outside renderer/ too (shared UI and transport codecs).
// TypeScript owns module resolution; package dependencies are already covered
// by the lockfile and must not turn this into a node_modules fingerprint.
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const require = createRequire(new URL('../../desktop/package.json', import.meta.url));
const ts = require('typescript');
const sourceFile = /\.[cm]?[jt]sx?$/i;
const options = {
  allowJs: true,
  resolveJsonModule: true,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  jsx: ts.JsxEmit.Preserve,
};

export async function rendererDependencyFiles(inputs) {
  const files = new Set(inputs.map((file) => resolve(file)));
  const cache = ts.createModuleResolutionCache(process.cwd(), (path) => path, options);
  for (const file of files) {
    if (!sourceFile.test(file)) continue;
    const text = await readFile(file, 'utf8');
    for (const dependency of ts.preProcessFile(text, true, true).importedFiles) {
      if (!dependency.fileName.startsWith('.')) continue;
      const resolved = ts.resolveModuleName(
        dependency.fileName, file, options, ts.sys, cache,
      ).resolvedModule;
      if (resolved && !resolved.isExternalLibraryImport
        && !/[\\/]node_modules[\\/]/.test(resolved.resolvedFileName)) {
        files.add(resolve(resolved.resolvedFileName));
      }
    }
  }
  return [...files];
}
