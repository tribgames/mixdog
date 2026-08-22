import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';

// Test preload: React only exports `act` from its development build, so a
// machine-level NODE_ENV=production silently breaks every DOM suite. Loaded
// via --import before any test file evaluates its React imports; unit tests
// always run against the development build regardless of ambient env. The
// tsx test loader uses classic JSX, so expose the same development React
// instance without keeping otherwise-unused default imports in source files.
process.env.NODE_ENV = 'development';
// Deterministic UI language: Node 22's built-in navigator.language reports
// the OS locale (ko-KR on Korean hosts), which would flip the renderer's
// i18n into Korean and break every English-asserting suite. Tests always run
// English unless a suite opts into another language explicitly.
process.env.MIXDOG_UI_LANGUAGE ||= 'en';
// ONE React per desktop test process. Shared modules that live outside this
// package (src/tui/**, imported by renderer suites) resolve `react` from the
// ROOT node_modules, so a hook of theirs rendered by the desktop react-dom
// read a foreign, uninitialised dispatcher and every hook call failed with
// "Cannot read properties of null (reading 'useRef')". The duplicate is a
// workspace layout accident (identical versions in two node_modules trees),
// so the desktop boundary pins every react/react-dom specifier to the copy
// this package renders with. Shared modules stay untouched.
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
// The pin is only sound while the two trees hold the SAME React: it silences a
// duplicate, it does not reconcile versions. apps/desktop declares a range
// (`react`/`react-dom` ^19.2.0), so an install may legitimately leave the root
// tree on a different resolved version — the pin would then quietly run shared
// modules against a React they were not built with. Fail loudly instead.
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
      `[test-env] ${specifier} version drift between workspace trees: `
      + `apps/desktop ${desktopVersion} vs repository root ${rootVersion}. `
      + 'Desktop tests pin every React specifier to the desktop copy, so this '
      + 'mismatch would be hidden instead of tested. Align the two installs '
      + '(or narrow apps/desktop/package.json) before running the suite.',
    );
  }
}
registerHooks({
  resolve(specifier, context, nextResolve) {
    const url = pinnedReactUrls.get(specifier);
    return url ? { url, shortCircuit: true } : nextResolve(specifier, context);
  },
});

const reactModule = await import('react');
globalThis.React = reactModule.default ?? reactModule;
// Bounded assertion rendering is NOT installed here on purpose: a preload-only
// shim silently disappears whenever a suite is run with a different command.
// scripts/bounded-assert.mjs is installed by the DOM harness instead, so every
// file that can hold a JSDOM graph carries it through its own imports.
