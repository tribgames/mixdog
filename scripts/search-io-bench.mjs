import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';

const root = await fs.mkdtemp(join(tmpdir(), 'mixdog-search-io-bench-'));
process.env.MIXDOG_DATA_DIR = join(root, 'data');
const { executeBuiltinTool } = await import('../src/runtime/agent/orchestrator/tools/builtin.mjs');
const { invalidateBuiltinResultCache } = await import('../src/runtime/agent/orchestrator/tools/builtin/cache-layers.mjs');
const { warmNativeSearchServer, shutdownNativeSearchServer } = await import('../src/runtime/agent/orchestrator/tools/builtin/native-search-client.mjs');
const { flushReadRangeIndexesSync } = await import('../src/runtime/agent/orchestrator/tools/builtin/read-range-index.mjs');
const { normalizeToolEnvelope } = await import('../src/runtime/agent/orchestrator/session/tool-envelope.mjs');
const entries = join(root, 'entries');
const docs = join(root, 'docs');
const file = join(docs, 'large.txt');
const originalOpen = fs.open;
let opens = 0;
let bytes = 0;
fs.open = async (...args) => {
    const handle = await originalOpen(...args);
    if (String(args[0]) === file) {
        opens++;
        const read = handle.read.bind(handle);
        handle.read = async (...a) => {
            const result = await read(...a);
            bytes += result.bytesRead;
            return result;
        };
    }
    return handle;
};
syncBuiltinESMExports();
try {
    await fs.mkdir(entries);
    await fs.mkdir(docs);
    for (let i = 0; i < 3000; i += 50) {
        await Promise.all(Array.from({ length: 50 }, (_, j) => fs.writeFile(
            join(entries, `entry-${String(i + j).padStart(5, '0')}.txt`), 'text\n',
        )));
    }
    await fs.writeFile(file, Array.from({ length: 30000 }, (_, i) => (
        `${i === 29970 ? 'ALPHA_MARK' : i === 29980 ? 'BETA_MARK' : 'row'} ${i} ${'x'.repeat(240)}\n`
    )).join(''));
    await warmNativeSearchServer();
    const cases = [
        ['glob_natural', 'glob', { path: entries, pattern: '*.txt', sort: 'natural', limit: 25 }, /entry-/],
        ['glob_mtime', 'glob', { path: entries, pattern: '*.txt', sort: 'mtime', limit: 25 }, /entry-/],
        ['grep_late_context0', 'grep', { path: file, pattern: 'ALPHA_MARK', context: 0 }, /ALPHA_MARK/],
        ['grep_late_context', 'grep', { path: file, pattern: 'ALPHA_MARK' }, /ALPHA_MARK/],
        ['grep_two_context', 'grep', { path: docs, pattern: ['ALPHA_MARK', 'BETA_MARK'] }, /BETA_MARK/],
        ['read_first5', 'read', { path: file, offset: 0, limit: 5 }, /row 0/],
    ];
    console.log('Six runs per case; JS result caches cleared, native/OS caches may remain warm.');
    for (const [name, tool, args, expected] of cases) {
        const ms = [];
        let totalOpens = 0;
        let totalBytes = 0;
        for (let i = 0; i < 6; i++) {
            invalidateBuiltinResultCache();
            opens = 0;
            bytes = 0;
            const start = performance.now();
            const raw = await executeBuiltinTool(tool, args, root, {
                sessionId: 'search-io-bench', suppressReadUnchangedStub: true,
            });
            const text = String(normalizeToolEnvelope(raw).result ?? '');
            ms.push(performance.now() - start);
            if (!expected.test(text)) throw new Error(`${name}: ${text.slice(0, 300)}`);
            if (/partial|incomplete|timed out/i.test(text)) {
                throw new Error(`${name} did not complete normally: ${text.slice(-500)}`);
            }
            totalOpens += opens;
            totalBytes += bytes;
        }
        ms.sort((a, b) => a - b);
        console.log(JSON.stringify({
            name, medianMs: Number(((ms[2] + ms[3]) / 2).toFixed(3)),
            maxMs: Number(ms[5].toFixed(3)),
            jsHandleOpens: totalOpens / 6, jsHandleBytes: Math.round(totalBytes / 6),
            normalResponsesOnly: true,
        }));
    }
} finally {
    fs.open = originalOpen;
    syncBuiltinESMExports();
    await shutdownNativeSearchServer('search-io-bench');
    flushReadRangeIndexesSync();
    await fs.rm(root, { recursive: true, force: true });
}
