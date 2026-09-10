import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const scope = resolve(process.argv[2] || '.');
const selected = new Set((process.argv[3] || 'find,glob,grep,code_graph').split(','));
const attempts = Math.max(1, Math.min(10, Number(process.argv[4]) || 3));
const cases = [
    ['find', { query: 'mixdog read range index', limit: 25 }],
    ['glob', { pattern: '**/read-range-index.mjs', sort: 'natural', limit: 25 }],
    ['grep', { pattern: 'executeGrepTool', mode: 'files', glob: '**/search-grep-tool.mjs', limit: 25 }],
    ['code_graph', { mode: 'find_symbol', symbols: ['executeGrepTool'], body: false, limit: 10 }],
];
const child = `
    import fs from 'node:fs/promises';
    import { tmpdir } from 'node:os';
    import { join } from 'node:path';
    import { performance } from 'node:perf_hooks';
    const [tool, args, scope, attempts] = JSON.parse(process.argv[1]);
    const data = await fs.mkdtemp(join(tmpdir(), 'mixdog-root-bench-'));
    process.env.MIXDOG_DATA_DIR = data;
    process.env.MIXDOG_GRAPH_BIN = join(process.cwd(), 'native/mixdog-graph/target/release',
        process.platform === 'win32' ? 'mixdog-graph.exe' : 'mixdog-graph');
    process.env.MIXDOG_SEARCH_SERVER_BIN = process.env.MIXDOG_GRAPH_BIN;
    const { executeBuiltinTool } = await import('./src/runtime/agent/orchestrator/tools/builtin.mjs');
    const { executeCodeGraphTool } = await import('./src/runtime/agent/orchestrator/tools/code-graph.mjs');
    const { warmNativeSearchServer, shutdownNativeSearchServer } = await import('./src/runtime/agent/orchestrator/tools/builtin/native-search-client.mjs');
    const { runWithLocalSearchTelemetry } = await import('./src/runtime/agent/orchestrator/tools/builtin/local-search-telemetry.mjs');
    const { normalizeToolEnvelope } = await import('./src/runtime/agent/orchestrator/session/tool-envelope.mjs');
    try {
        if (tool !== 'code_graph') await warmNativeSearchServer();
        for (let attempt = 1; attempt <= attempts; attempt++) {
            const telemetry = {};
            const start = performance.now();
            try {
                const raw = await runWithLocalSearchTelemetry(telemetry, () => tool === 'code_graph'
                    ? executeCodeGraphTool(tool, args, scope)
                    : executeBuiltinTool(tool, args, scope, { sessionId: 'root-bench' }));
                const text = String(normalizeToolEnvelope(raw).result ?? '');
                console.log(JSON.stringify({
                    tool, scope, attempt, ms: +(performance.now() - start).toFixed(1),
                    bytes: Buffer.byteLength(text), partial: /partial|incomplete|timed out/i.test(text),
                    malformedPath: /\\?\\/[A-Za-z]:/.test(text),
                    preview: text.slice(0, 150), tail: text.slice(-300), telemetry,
                }));
            } catch (error) {
                console.log(JSON.stringify({ tool, scope, attempt,
                    ms: +(performance.now() - start).toFixed(1), error: error.message }));
            }
        }
    } finally {
        await shutdownNativeSearchServer('root-bench');
        await fs.rm(data, { recursive: true, force: true });
    }
`;
console.log(`Root benchmark: ${scope}; fresh process/cache directory per tool; OS caches retained; native startup excluded.`);
for (const [tool, args] of cases) {
    if (!selected.has(tool)) continue;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', child, JSON.stringify([tool, args, scope, attempts])], {
        cwd: process.cwd(), encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
    });
    process.stdout.write(result.stdout || '');
    if (result.status !== 0) {
        process.stderr.write(result.stderr || '');
        process.exitCode = 1;
    }
}
