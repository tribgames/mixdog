import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const traceModuleUrl = pathToFileURL(join(root, 'src/runtime/agent/orchestrator/agent-trace-io.mjs')).href;

test('drainAgentTrace awaits delayed local JSONL append without a memory service', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-agent-trace-io-test-'));
  const tracePath = join(dir, 'agent-trace.jsonl');
  const loaderPath = join(dir, 'loader.mjs');
  const delayedFsPath = join(dir, 'delayed-fs-promises.mjs');
  try {
    writeFileSync(delayedFsPath, `
      import { appendFile as realAppendFile } from 'node:fs/promises';
      export async function appendFile(...args) {
        await new Promise((resolve) => setTimeout(resolve, Number(process.env.TRACE_APPEND_DELAY_MS)));
        return realAppendFile(...args);
      }
    `);
    writeFileSync(loaderPath, `
      export async function resolve(specifier, context, nextResolve) {
        if (specifier === 'fs/promises' && context.parentURL === ${JSON.stringify(traceModuleUrl)}) {
          return { url: new URL('./delayed-fs-promises.mjs', import.meta.url).href, shortCircuit: true };
        }
        return nextResolve(specifier, context);
      }
    `);
    const child = spawnSync(process.execPath, [
      '--experimental-loader',
      pathToFileURL(loaderPath).href,
      '--input-type=module',
      '-e',
      `
        import { readFileSync } from 'node:fs';
        import { appendAgentTrace, drainAgentTrace } from ${JSON.stringify(traceModuleUrl)};
        appendAgentTrace({ kind: 'delayed-local-test', session_id: 'sess_delayed' });
        const started = Date.now();
        await drainAgentTrace();
        const rows = readFileSync(process.env.MIXDOG_AGENT_TRACE_PATH, 'utf8').trim().split(/\\r?\\n/).map(JSON.parse);
        process.stdout.write(JSON.stringify({ elapsed: Date.now() - started, rows }));
      `,
    ], {
      encoding: 'utf8',
      env: {
        ...process.env,
        MIXDOG_AGENT_TRACE_PATH: tracePath,
        MIXDOG_AGENT_TRACE_DISABLE: '',
        MIXDOG_AGENT_TRACE_LOCAL_DISABLE: '',
        MIXDOG_RUNTIME_ROOT: join(dir, 'no-service'),
        TRACE_APPEND_DELAY_MS: '75',
      },
      timeout: 5000,
    });
    assert.equal(child.status, 0, child.stderr || child.stdout);
    const result = JSON.parse(child.stdout);
    assert.ok(result.elapsed >= 60, `drain returned before delayed append (${result.elapsed}ms)`);
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].kind, 'delayed-local-test');
    assert.equal(result.rows[0].session_id, 'sess_delayed');
    assert.match(readFileSync(tracePath, 'utf8'), /"kind":"delayed-local-test"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
