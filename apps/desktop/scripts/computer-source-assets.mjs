import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const sourceCall = /\bloadComputerSource\('([A-Za-z][A-Za-z0-9-]*\.(?:cs|ps1))'\)/g;
const backendModule = /[/\\]computer[/\\]backend[/\\](?:native-source|ps-[\w-]+)\.ts$/;

function embed(source, id, watch = () => {}) {
  if (!backendModule.test(id)) return null;
  let changed = false;
  const code = source.replace(sourceCall, (_call, name) => {
    const path = resolve(dirname(id), 'sources', name);
    watch(path);
    changed = true;
    return JSON.stringify(readFileSync(path, 'utf8').replace(/\r\n/g, '\n'));
  });
  return changed ? code : null;
}

/** @returns {import('vite').Plugin} */
export function computerSourceVitePlugin() {
  return {
    name: 'mixdog-computer-source-assets',
    enforce: 'pre',
    transform(source, id) {
      const code = embed(source, id, (path) => this.addWatchFile(path));
      return code === null ? null : { code, map: null };
    },
  };
}

/** @returns {import('esbuild').Plugin} */
export function computerSourceEsbuildPlugin() {
  return {
    name: 'mixdog-computer-source-assets',
    setup(build) {
      build.onLoad({ filter: backendModule }, ({ path }) => {
        const watchFiles = [];
        const contents = embed(readFileSync(path, 'utf8'), path, (file) => watchFiles.push(file));
        return contents === null ? undefined : { contents, loader: 'ts', resolveDir: dirname(path), watchFiles };
      });
    },
  };
}
