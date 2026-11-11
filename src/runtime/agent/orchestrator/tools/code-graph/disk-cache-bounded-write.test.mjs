// A code-graph cache entry is written in pieces, never built and flattened as
// one string. The daemon runs on Electron's Node, where every isolate shares
// one 4 GB pointer-compression cage: flattening a mixdog-sized entry (33M
// two-byte chars) in a code-graph worker failed there with the worker's heap
// at 350 MB and aborted the daemon (2026-11-10 23:32). Plain Node has no such
// cage (nor a hard ceiling for one large allocation), so the bound is
// observed as the persist's peak memory against the size of what it wrote:
// written whole it grows with the entry (about twice its bytes), in pieces it
// levels off where the collector does (about 60 MB here at any entry size).
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const runNode = promisify(execFile);
const NODES = 4000;
// One shared string, so the graph itself stays small; two-byte like the "…"
// a truncated signature ends with. The entry is 40M chars: 80 MB as one
// string, 80 MB more flattened with its newline, 120 MB as UTF-8 bytes.
const SIGNATURE_CHARS = 10_000;

test('persisting a code-graph entry holds no copy of the whole entry in memory', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-cg-bounded-'));
  const script = `
    const [dataDir, nodeCount, signatureChars] = process.argv.slice(1);
    process.env.MIXDOG_DATA_DIR = dataDir;
    process.env.MIXDOG_CODE_GRAPH_CACHE_MAX_MB = '512';
    const CG = './src/runtime/agent/orchestrator/tools/code-graph/';
    const { _attachGraphRuntimeCaches } = await import(CG + 'graph-model.mjs');
    const { _setDiskCodeGraphEntry, drainCodeGraphCacheStrict } = await import(CG + 'disk-cache.mjs');
    const signature = '\\u2026'.repeat(Number(signatureChars));
    const nodes = new Map();
    for (let i = 0; i < Number(nodeCount); i += 1) {
      const rel = 'src/f' + i + '.js';
      nodes.set(rel, {
        abs: dataDir + '/' + rel, rel, lang: 'javascript', fingerprint: 'fp' + i, parseError: '',
        rawImports: [], resolvedImportsRel: [], resolvedImports: [], importedBy: [], packageName: '',
        namespaceName: '', goPackageName: '', topLevelTypes: [], tokenSymbols: null,
        symbols: [{ name: 'f' + i, kind: 'function', line: 1, signature }], calls: [],
      });
    }
    const root = dataDir + '/repo';
    const graph = _attachGraphRuntimeCaches({
      cwd: root, nodes, reverse: new Map(),
      schemaVersion: 'sym-range-v3-rustimports', builtAt: Date.now(), signature: 'sig-bounded',
    });
    _setDiskCodeGraphEntry(root, graph);
    const before = process.resourceUsage().maxRSS;
    drainCodeGraphCacheStrict();
    process.stdout.write(String((process.resourceUsage().maxRSS - before) * 1024));
  `;
  try {
    const { stdout } = await runNode(
      process.execPath,
      ['--input-type=module', '-e', script, dataDir, String(NODES), String(SIGNATURE_CHARS)],
      { cwd: process.cwd(), maxBuffer: 1024 * 1024 }
    );
    const dir = join(dataDir, 'code-graph-cache');
    const [{ hash }] = Object.values(JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')));
    const file = join(dir, `${hash}.json`);
    const { size } = statSync(file);
    const peakGrowth = Number(stdout);
    assert.ok(peakGrowth < size, `persist raised peak memory by ${peakGrowth} bytes for a ${size}-byte entry`);
    const entry = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(entry.nodes.length, NODES);
    assert.equal(entry.nodes.at(-1).symbols[0].signature, '\u2026'.repeat(SIGNATURE_CHARS));
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
