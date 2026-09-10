import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

const root = await fs.mkdtemp(join(tmpdir(), 'mixdog-read-range-bench-'));
process.env.MIXDOG_DATA_DIR = join(root, 'data');
const { streamReadRange } = await import('../src/runtime/agent/orchestrator/tools/builtin/read-streaming.mjs');
const { flushReadRangeIndexesSync } = await import('../src/runtime/agent/orchestrator/tools/builtin/read-range-index.mjs');
const file = join(root, 'large.txt');
const originalOpen = fs.open;
let opens = 0;
let bytes = 0;
fs.open = async (...args) => {
    const handle = await originalOpen(...args);
    if (args[0] === file) {
        opens++;
        const read = handle.read.bind(handle);
        handle.read = async (...readArgs) => {
            const result = await read(...readArgs);
            bytes += result.bytesRead;
            return result;
        };
    }
    return handle;
};
syncBuiltinESMExports();
try {
    await fs.writeFile(file, Array.from({ length: 40000 }, (_, i) => `row ${i} ${'x'.repeat(240)}\n`).join(''));
    const st = await fs.stat(file);
    for (const offset of [0, 30000]) {
        for (const phase of ['first', 'repeat']) {
            const runs = phase === 'first' ? 1 : 20;
            opens = 0;
            bytes = 0;
            const start = performance.now();
            for (let i = 0; i < runs; i++) {
                const result = await streamReadRange(file, offset, 5, st);
                if (!result.text.startsWith(`${offset + 1}→row ${offset} `)) {
                    throw new Error(`wrong range: ${result.text.slice(0, 100)}`);
                }
            }
            console.log(JSON.stringify({
                offset, phase, runs,
                msPerRead: Number(((performance.now() - start) / runs).toFixed(3)),
                opensPerRead: opens / runs,
                bytesPerRead: bytes / runs,
            }));
        }
    }
} finally {
    fs.open = originalOpen;
    syncBuiltinESMExports();
    flushReadRangeIndexesSync();
    await fs.rm(root, { recursive: true, force: true });
}
