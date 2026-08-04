#!/usr/bin/env node
/**
 * scripts/tui-render-smoke.mjs — undeclared-identifier gate for the TUI bundle.
 *
 * Why: esbuild does not flag free (undeclared) identifiers in JSX modules —
 * they may legitimately be runtime globals — and no smoke actually renders
 * App. That gap shipped two ReferenceErrors (promptContentRows,
 * TRANSCRIPT_WINDOW_OVERSCAN_ROWS) during the App.jsx split.
 *
 * How: parse src/tui/dist/index.mjs with acorn, run eslint-scope, and fail on
 * any reference that resolves to no binding and is not a known JS/Node/DOM
 * global. Static, deterministic, no terminal or engine session needed.
 *
 * Run:  node scripts/tui-render-smoke.mjs   (or `npm run smoke:tui`)
 * Exit: 0 = clean, 1 = undeclared identifiers found or bundle missing.
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';
import { analyze } from 'eslint-scope';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BUNDLE = join(ROOT, 'src', 'tui', 'dist', 'index.mjs');

// Globals that are legal free identifiers in the bundle. Anything outside
// this set that resolves to no binding is a guaranteed ReferenceError at
// runtime (module scope is strict; there is no window fallback in node ESM).
const KNOWN_GLOBALS = new Set([
  // ECMAScript builtins
  'Array', 'ArrayBuffer', 'Atomics', 'BigInt', 'BigInt64Array', 'BigUint64Array', 'Boolean',
  'DataView', 'Date', 'Error', 'EvalError', 'FinalizationRegistry', 'Float32Array',
  'Float64Array', 'Function', 'Infinity', 'Int8Array', 'Int16Array', 'Int32Array',
  'Intl', 'JSON', 'Map', 'Math', 'NaN', 'Number', 'Object', 'Promise', 'Proxy',
  'RangeError', 'ReferenceError', 'Reflect', 'RegExp', 'Set', 'SharedArrayBuffer',
  'String', 'Symbol', 'SyntaxError', 'TypeError', 'URIError', 'Uint8Array',
  'Uint8ClampedArray', 'Uint16Array', 'Uint32Array', 'WeakMap', 'WeakRef', 'WeakSet',
  'decodeURI', 'decodeURIComponent', 'encodeURI', 'encodeURIComponent', 'eval',
  'globalThis', 'isFinite', 'isNaN', 'parseFloat', 'parseInt', 'undefined',
  // Node.js globals
  'AbortController', 'AbortSignal', 'Blob', 'Buffer', 'ByteLengthQueuingStrategy',
  'CompressionStream', 'CountQueuingStrategy', 'Crypto', 'CryptoKey', 'CustomEvent',
  'DecompressionStream', 'Event', 'EventTarget', 'File', 'FormData', 'Headers',
  'MessageChannel', 'MessageEvent', 'MessagePort', 'Navigator', 'PerformanceEntry',
  'PerformanceObserver', 'ReadableStream', 'ReadableStreamDefaultReader', 'Request',
  'Response', 'SubtleCrypto', 'TextDecoder', 'TextDecoderStream', 'TextEncoder',
  'TextEncoderStream', 'TransformStream', 'URL', 'URLSearchParams', 'WebAssembly',
  'WebSocket', 'WritableStream', 'atob', 'btoa', 'clearImmediate', 'clearInterval',
  'clearTimeout', 'console', 'crypto', 'fetch', 'navigator', 'performance',
  'process', 'queueMicrotask', 'require', 'setImmediate', 'setInterval',
  'setTimeout', 'structuredClone',
  // Bundler/runtime artifacts occasionally referenced defensively
  'window', 'document', 'reportError',
]);

if (!existsSync(BUNDLE)) {
  console.error(`tui-render-smoke: FAIL — bundle not found at ${BUNDLE}; run \`npm run build:tui\` first`);
  process.exit(1);
}

const source = readFileSync(BUNDLE, 'utf8');

let ast;
try {
  ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module', locations: true, ranges: true });
} catch (err) {
  console.error(`tui-render-smoke: FAIL — bundle does not parse: ${err.message}`);
  process.exit(1);
}

const scopeManager = analyze(ast, { ecmaVersion: 2022, sourceType: 'module' });
const unresolved = scopeManager.globalScope.through.filter(
  (ref) => !KNOWN_GLOBALS.has(ref.identifier.name),
);

if (unresolved.length > 0) {
  const seen = new Map();
  for (const ref of unresolved) {
    const { name } = ref.identifier;
    if (!seen.has(name)) seen.set(name, ref.identifier.loc?.start);
  }
  console.error(`tui-render-smoke: FAIL — ${seen.size} undeclared identifier(s) in src/tui/dist/index.mjs:`);
  for (const [name, loc] of seen) {
    console.error(`  ${name} (dist/index.mjs:${loc ? `${loc.line}:${loc.column}` : '?'})`);
  }
  console.error('These throw ReferenceError when the TUI renders. Fix missing imports in src/tui/ and rebuild.');
  process.exit(1);
}

console.log('tui-render-smoke: ok — no undeclared identifiers in TUI bundle');
