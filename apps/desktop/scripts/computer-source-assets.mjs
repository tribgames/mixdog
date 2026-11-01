import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

const sourceCall = /\bloadComputerSource\('([A-Za-z][A-Za-z0-9-]*\.(?:cs|ps1|cjs))'\)/g;
const backendModule = /[/\\]computer[/\\]backend[/\\](?:native-source|foreground-lock-host|ps-[\w-]+)\.ts$/;
// The overlay pill ships the app's own face; the installed app has no
// node_modules to read it from, so the bytes travel inside the bundle.
const fontCall = /\bloadOverlayFont\('(pretendard\/[\w./-]+\.woff2)'\)/g;
const overlayModule = /[/\\]computer[/\\]overlay[/\\]content\.ts$/;
const embeddedModule = new RegExp(`(?:${backendModule.source})|(?:${overlayModule.source})`);
const packageRequire = createRequire(import.meta.url);

/** Each embedded call becomes the literal its source-execution loader returns. */
function embed(source, id, watch = () => {}) {
  let call, read;
  if (backendModule.test(id)) {
    call = sourceCall;
    read = (name) => {
      const path = resolve(dirname(id), 'sources', name);
      watch(path);
      return readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
    };
  } else if (overlayModule.test(id)) {
    call = fontCall;
    read = (specifier) => {
      const path = packageRequire.resolve(specifier);
      watch(path);
      return readFileSync(path).toString('base64');
    };
  } else return null;
  let changed = false;
  const code = source.replace(call, (_call, name) => {
    changed = true;
    return JSON.stringify(read(name));
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
      build.onLoad({ filter: embeddedModule }, ({ path }) => {
        const watchFiles = [];
        const contents = embed(readFileSync(path, 'utf8'), path, (file) => watchFiles.push(file));
        return contents === null ? undefined : { contents, loader: 'ts', resolveDir: dirname(path), watchFiles };
      });
    },
  };
}
