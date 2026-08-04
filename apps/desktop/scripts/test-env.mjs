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
const reactModule = await import('react');
globalThis.React = reactModule.default ?? reactModule;
// Bounded assertion rendering is NOT installed here on purpose: a preload-only
// shim silently disappears whenever a suite is run with a different command.
// scripts/bounded-assert.mjs is installed by the DOM harness instead, so every
// file that can hold a JSDOM graph carries it through its own imports.
