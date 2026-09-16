import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

for (const failure of ['none', 'ask', 'close']) {
  test(`headless exit persists in-flight and queued trace rows before cleanup (${failure})`, () => {
    const root = mkdtempSync(join(tmpdir(), 'mixdog-headless-trace-'));
    const tracePath = join(root, 'agent-trace.jsonl');
    try {
      const child = spawnSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `
        import fsPromises from 'node:fs/promises';
        import { existsSync, readFileSync } from 'node:fs';
        import { syncBuiltinESMExports } from 'node:module';

        // Keep an append pending while the runtime finishes. The explicit
        // process exit mirrors the CLI rather than letting Node drain IO.
        const append = fsPromises.appendFile;
        fsPromises.appendFile = async (...args) => {
          await new Promise(resolve => setTimeout(resolve, 100));
          return append(...args);
        };
        syncBuiltinESMExports();
        const { runHeadlessExec } = await import('./src/headless-exec.mjs');
        const { appendAgentTrace } = await import('./src/runtime/agent/orchestrator/agent-trace-io.mjs');
        const failure = ${JSON.stringify(failure)};
        const readSequences = () => existsSync(process.env.MIXDOG_AGENT_TRACE_PATH)
          ? readFileSync(process.env.MIXDOG_AGENT_TRACE_PATH, 'utf8')
            .split(/\\r?\\n/).filter(Boolean).map(JSON.parse)
            .filter(row => row.kind === 'exit-test').map(row => row.sequence)
          : [];
        const emit = sequence => appendAgentTrace({
          sessionId: 'headless-trace-test', kind: 'exit-test', sequence,
        });
        let beforeBoundaryCleanup;
        const code = await runHeadlessExec({
          message: 'finish',
          provider: 'openai-oauth',
          model: 'test-model',
          usageLogPath: '',
          write() {},
          writeErr() {},
          boundaryFactory: () => ({
            runtimeRoot: process.env.MIXDOG_RUNTIME_ROOT,
            loadConfig: () => ({}),
            cleanup() { beforeBoundaryCleanup = readSequences(); },
          }),
          runtimeFactory: async () => ({
            id: 'headless-trace-test',
            async ask() {
              for (let i = 0; i < 100; i++) emit(i);
              if (failure === 'ask') throw new Error('execution failed');
              return { result: { content: 'done' } };
            },
            async close() {
              emit(100);
              if (failure === 'close') throw new Error('shutdown failed');
            },
          }),
          memoryRuntimeCleanup: async () => {},
          daemonRuntimeCleanup: async () => {},
          hasActiveTasks: () => false,
          installSignalCleanupFn: () => ({ uninstall() {} }),
        });
        process.stdout.write(JSON.stringify({
          beforeBoundaryCleanup, beforeExit: readSequences(),
        }));
        process.exit(code);
      `,
        ],
        {
          cwd: process.cwd(),
          encoding: 'utf8',
          env: {
            ...process.env,
            MIXDOG_RUNTIME_ROOT: join(root, 'runtime'),
            MIXDOG_AGENT_TRACE_PATH: tracePath,
            MIXDOG_AGENT_TRACE_DISABLE: '',
            MIXDOG_AGENT_TRACE_LOCAL_DISABLE: '',
            MIXDOG_DISABLE_TOOL_PREWARM: '1',
          },
        }
      );
      assert.equal(child.status, failure === 'none' ? 0 : 1, child.stderr);
      const expected = Array.from({ length: 101 }, (_, i) => i);
      const observed = JSON.parse(child.stdout);
      assert.deepEqual(observed.beforeBoundaryCleanup, expected);
      assert.deepEqual(observed.beforeExit, expected);
      const persisted = readFileSync(tracePath, 'utf8')
        .split(/\r?\n/)
        .filter(Boolean)
        .map(JSON.parse)
        .filter((row) => row.kind === 'exit-test')
        .map((row) => row.sequence);
      assert.deepEqual(persisted, expected);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
