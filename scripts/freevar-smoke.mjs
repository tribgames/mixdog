#!/usr/bin/env node
/**
 * scripts/freevar-smoke.mjs — undeclared-identifier gate for runtime source.
 *
 * Same engine as tui-render-smoke.mjs (acorn + eslint-scope) but pointed at
 * the plain-ESM runtime sources instead of the TUI bundle. Any reference that
 * resolves to no binding and is not a known Node global is a guaranteed
 * ReferenceError on that code path — exactly the class of bug that section
 * extractions leave behind on cold paths (missed import, orphaned helper).
 *
 * Run:  node scripts/freevar-smoke.mjs   (or `npm run smoke:freevars`)
 * Exit: 0 = clean, 1 = undeclared identifiers found / parse failure.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';
import { analyze } from 'eslint-scope';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// Plain .mjs source roots. src/tui is covered by smoke:tui on the BUILT
// bundle (App.jsx is JSX — acorn can't parse it raw); vendor is third-party.
const SCAN_ROOTS = ['src/runtime', 'src/standalone', 'src/shared', 'scripts'].map(p => join(ROOT, p));
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git']);

const KNOWN_GLOBALS = new Set([
  'Array', 'ArrayBuffer', 'Atomics', 'BigInt', 'BigInt64Array', 'BigUint64Array', 'Boolean',
  'DataView', 'Date', 'Error', 'EvalError', 'FinalizationRegistry', 'Float32Array',
  'Float64Array', 'Function', 'Infinity', 'Int8Array', 'Int16Array', 'Int32Array',
  'Intl', 'JSON', 'Map', 'Math', 'NaN', 'Number', 'Object', 'Promise', 'Proxy',
  'RangeError', 'ReferenceError', 'Reflect', 'RegExp', 'Set', 'SharedArrayBuffer',
  'String', 'Symbol', 'SyntaxError', 'TypeError', 'URIError', 'Uint8Array',
  'Uint8ClampedArray', 'Uint16Array', 'Uint32Array', 'WeakMap', 'WeakRef', 'WeakSet',
  'decodeURI', 'decodeURIComponent', 'encodeURI', 'encodeURIComponent', 'eval',
  'globalThis', 'isFinite', 'isNaN', 'parseFloat', 'parseInt', 'undefined',
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
  'setTimeout', 'structuredClone', 'reportError',
  // Browser globals: legal inside puppeteer page.evaluate() callbacks, which
  // execute in the BROWSER context (web-tools.mjs scrapers).
  'document', 'window',
]);

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else if (name.endsWith('.mjs')) yield p;
  }
}

let failures = 0;
let scanned = 0;
for (const root of SCAN_ROOTS) {
  let files;
  try { files = [...walk(root)]; } catch { continue; }
  for (const file of files) {
    scanned++;
    const source = readFileSync(file, 'utf8');
    let ast;
    try {
      ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module', locations: true, ranges: true });
    } catch (err) {
      failures++;
      console.error(`freevar-smoke: PARSE FAIL ${relative(ROOT, file)}: ${err.message}`);
      continue;
    }
    const scopeManager = analyze(ast, { ecmaVersion: 2022, sourceType: 'module' });
    const seen = new Set();
    for (const ref of scopeManager.globalScope.through) {
      const { name } = ref.identifier;
      if (KNOWN_GLOBALS.has(name) || seen.has(name)) continue;
      seen.add(name);
      failures++;
      const loc = ref.identifier.loc?.start;
      console.error(`freevar-smoke: FAIL ${relative(ROOT, file)}:${loc ? `${loc.line}:${loc.column}` : '?'} — undeclared identifier \`${name}\``);
    }
  }
}

if (failures > 0) {
  console.error(`freevar-smoke: ${failures} problem(s) across ${scanned} files — these are ReferenceErrors waiting on their code path.`);
  process.exit(1);
}
console.log(`freevar-smoke: ok — ${scanned} files, no undeclared identifiers`);
