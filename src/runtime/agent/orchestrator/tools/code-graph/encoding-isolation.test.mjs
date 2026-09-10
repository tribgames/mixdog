import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const binary = resolve('native/mixdog-graph/target/release', process.platform === 'win32' ? 'mixdog-graph.exe' : 'mixdog-graph');

test('invalid source encoding is isolated and remains visible on cached graph queries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mixdog-graph-encoding-'));
    try {
        await writeFile(join(root, 'package.json'), '{}');
        await writeFile(join(root, 'valid.mjs'), 'export function GraphEncodingNeedle() { return 1; }\n');
        await writeFile(join(root, 'invalid.cs'), Buffer.from([47, 47, 32, 233, 10]));
        const script = `
            import assert from 'node:assert/strict';
            import { writeFile } from 'node:fs/promises';
            import { join } from 'node:path';
            const root = process.argv[1];
            process.env.MIXDOG_DATA_DIR = join(root, 'data');
            process.env.MIXDOG_GRAPH_BIN = process.argv[2];
            const { executeCodeGraphTool } = await import('./src/runtime/agent/orchestrator/tools/code-graph.mjs');
            const { _buildCodeGraph } = await import('./src/runtime/agent/orchestrator/tools/code-graph/build.mjs');
            const { _serializeGraph, _deserializeGraph } = await import('./src/runtime/agent/orchestrator/tools/code-graph/graph-model.mjs');
            for (let i = 0; i < 2; i++) {
                const out = await executeCodeGraphTool('code_graph', {
                    mode: 'find_symbol', symbols: ['GraphEncodingNeedle'], body: false,
                }, root);
                assert.match(out, /valid.mjs/);
                assert.match(out, /invalid.cs: unsupported source encoding/);
                assert.match(out, /graph results are partial/);
            }
            const graph = await _buildCodeGraph(root);
            const restored = _deserializeGraph(root, _serializeGraph(graph));
            assert.match(restored.nodes.get('invalid.cs').parseError, /encoding/);
            // An unrelated edit must reuse the invalid file's diagnostic.
            await writeFile(join(root, 'valid.mjs'), 'export function GraphEncodingNeedle() { return 222; }\\n');
            const changed = await _buildCodeGraph(root);
            assert.match(changed.nodes.get('invalid.cs').parseError, /encoding/);
            await writeFile(join(root, 'invalid.cs'), 'public class EncodingRepaired {}\\n');
            const repaired = await _buildCodeGraph(root);
            assert.equal(repaired.nodes.get('invalid.cs').parseError, '');
            assert.ok(repaired.nodes.get('invalid.cs').symbols.some((s) => s.name === 'EncodingRepaired'));
        `;
        await run(process.execPath, ['--input-type=module', '-e', script, root, binary], {
            cwd: process.cwd(), maxBuffer: 2 * 1024 * 1024,
        });
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
