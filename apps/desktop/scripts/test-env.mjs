import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pruneStaleTempDirs, removeTempDirSync } from '../../../scripts/lib/stale-temp.mjs';
import { installBoundedAssertions } from './bounded-assert.mjs';

// A fixture must never write diagnostic history into the signed-in app's store.
// Each test process owns its directory, including when the caller set a live path.
const TEST_DATA_PREFIX = 'mixdog-desktop-tests-';
pruneStaleTempDirs([TEST_DATA_PREFIX]);
const testDataDir = mkdtempSync(join(tmpdir(), TEST_DATA_PREFIX));
process.env.MIXDOG_DATA_DIR = testDataDir;
// One directory per test process; without this every run left one behind.
process.on('exit', () => removeTempDirSync(testDataDir));

// React exports `act` only from its development build.
process.env.NODE_ENV = 'development';
// Node 22's navigator.language reports the OS locale, which would switch the renderer's i18n.
process.env.MIXDOG_UI_LANGUAGE ||= 'en';
// Shared modules outside this package resolve `react` from the root node_modules; a second React copy gives
// their hooks a null dispatcher, so every react/react-dom specifier is pinned to this package's copy.
const reactRequire = createRequire(import.meta.url);
const REACT_SPECIFIERS = [
  'react',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
  'react-dom',
  'react-dom/client',
  'react-dom/server',
  'react-dom/test-utils',
];
const pinnedReactUrls = new Map();
for (const specifier of REACT_SPECIFIERS) {
  try {
    pinnedReactUrls.set(specifier, pathToFileURL(reactRequire.resolve(specifier)).href);
  } catch {
    // Not installed for this suite; nothing to pin.
  }
}
const rootRequire = createRequire(new URL('../../../package.json', import.meta.url));
const packageVersion = (resolver, specifier) => {
  try {
    return resolver(`${specifier}/package.json`).version ?? null;
  } catch {
    return null; // Not installed in that tree; nothing to compare.
  }
};
for (const specifier of ['react', 'react-dom']) {
  const desktopVersion = packageVersion(reactRequire, specifier);
  const rootVersion = packageVersion(rootRequire, specifier);
  if (desktopVersion && rootVersion && desktopVersion !== rootVersion) {
    throw new Error(
      `[test-env] ${specifier} version drift between workspace trees: ` +
        `apps/desktop ${desktopVersion} vs repository root ${rootVersion}. ` +
        'Desktop tests pin every React specifier to the desktop copy, so this ' +
        'mismatch would be hidden instead of tested. Align the two installs ' +
        '(or narrow apps/desktop/package.json) before running the suite.'
    );
  }
}
// Node has no CSS loader (ERR_UNKNOWN_FILE_EXTENSION); a synchronous `load` hook would break the CommonJS path.
const EMPTY_MODULE_URL = 'data:text/javascript,';
// Image and video imports become Vite asset URLs at build time; under test they
// resolve to a module whose default export is the specifier, the same string shape.
const IMAGE_SPECIFIER = /\.(?:png|jpe?g|gif|webp|avif|svg|webm|mp4)$/i;
registerHooks({
  resolve(specifier, context, nextResolve) {
    const url = pinnedReactUrls.get(specifier);
    if (url) return { url, shortCircuit: true };
    if (/\.css$/i.test(specifier)) return { url: EMPTY_MODULE_URL, shortCircuit: true };
    // The build fills the phone pane prefetch lists (scripts/chunk-prefetch.ts);
    // under test, as on the dev server, they are empty.
    if (specifier === 'virtual:mixdog-chunk-prefetch') {
      return { url: 'data:text/javascript,export%20const%20chunkFiles%20%3D%20%7B%7D%3B', shortCircuit: true };
    }
    if (IMAGE_SPECIFIER.test(specifier)) {
      const source = `export default ${JSON.stringify(specifier)};`;
      return { url: `data:text/javascript,${encodeURIComponent(source)}`, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const reactModule = await import('react');
globalThis.React = reactModule.default ?? reactModule;
installBoundedAssertions();
