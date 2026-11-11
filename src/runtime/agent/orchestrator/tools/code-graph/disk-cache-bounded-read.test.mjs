// A code-graph cache entry is loaded in pieces, never read into one string.
// The daemon runs on Electron's Node, where every isolate shares one 4 GB
// pointer-compression cage; a mixdog-sized entry is a 66M-char string, the
// single allocation that aborted the daemon when it was written (b686de38b)
// and was still made, whole, by every load. The load is observed through the
// largest text JSON.parse is handed while it runs: the whole file before, one
// node after.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const runNode = promisify(execFile);
const NODES = 600;
const SIGNATURE_CHARS = 2_000;
const CG = './src/runtime/agent/orchestrator/tools/code-graph/';

const persistScript = `
  const [dataDir, nodeCount, signatureChars] = process.argv.slice(1);
  process.env.MIXDOG_DATA_DIR = dataDir;
  const { _attachGraphRuntimeCaches } = await import('${CG}graph-model.mjs');
  const { _setDiskCodeGraphEntry, drainCodeGraphCacheStrict } = await import('${CG}disk-cache.mjs');
  const signature = 'x'.repeat(Number(signatureChars));
  const nodes = new Map();
  for (let i = 0; i < Number(nodeCount); i += 1) {
    const rel = 'src/f' + i + '.js';
    nodes.set(rel, {
      abs: dataDir + '/' + rel, rel, lang: 'javascript', fingerprint: 'fp' + i, parseError: '',
      rawImports: [], resolvedImportsRel: [], resolvedImports: [], importedBy: [], packageName: '',
      namespaceName: '', goPackageName: '', topLevelTypes: [], tokenSymbols: null,
      symbols: [{ name: 'f' + i, kind: 'function', line: 1, signature: signature + i }], calls: [],
    });
  }
  const root = dataDir + '/repo';
  _setDiskCodeGraphEntry(root, _attachGraphRuntimeCaches({
    cwd: root, nodes, reverse: new Map(),
    schemaVersion: 'sym-range-v3-rustimports', builtAt: Date.now(), signature: 'sig-bounded-read',
  }));
  drainCodeGraphCacheStrict();
`;

const loadScript = `
  const [dataDir] = process.argv.slice(1);
  process.env.MIXDOG_DATA_DIR = dataDir;
  const { getDiskCodeGraphEntry, ensureDiskCodeGraphLoaded } = await import('${CG}disk-cache.mjs');
  ensureDiskCodeGraphLoaded();
  let longest = 0;
  const parse = JSON.parse;
  JSON.parse = (text, ...rest) => {
    longest = Math.max(longest, String(text).length);
    return parse(text, ...rest);
  };
  const entry = getDiskCodeGraphEntry(dataDir + '/repo');
  JSON.parse = parse;
  process.stdout.write(JSON.stringify({ longest, entry }));
`;

test('loading a code-graph entry never holds the whole entry as one string', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-cg-bounded-read-'));
  const run = (script, ...args) =>
    runNode(process.execPath, ['--input-type=module', '-e', script, dataDir, ...args], {
      cwd: process.cwd(),
      maxBuffer: 64 * 1024 * 1024,
    });
  try {
    await run(persistScript, String(NODES), String(SIGNATURE_CHARS));
    const dir = join(dataDir, 'code-graph-cache');
    const [{ hash }] = Object.values(JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')));
    const file = join(dir, `${hash}.json`);
    const { size } = statSync(file);
    const { stdout } = await run(loadScript);
    const { longest, entry } = JSON.parse(stdout);
    assert.ok(size > NODES * SIGNATURE_CHARS, `the entry is ${size} bytes`);
    assert.ok(longest < size / 20, `JSON.parse was handed ${longest} characters of a ${size}-byte entry`);
    assert.deepEqual(entry, JSON.parse(readFileSync(file, 'utf8')), 'the entry read is the entry written');
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
