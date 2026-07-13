import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const traceModuleUrl = pathToFileURL(join(root, 'src/runtime/agent/orchestrator/agent-trace-io.mjs')).href;

test('drainAgentTrace awaits delayed local JSONL append without a memory service', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-agent-trace-io-test-'));
  const traceParent = join(dir, 'nested');
  const tracePath = join(traceParent, 'history', 'agent-trace.jsonl');
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
        import { readFileSync, rmSync } from 'node:fs';
        import { appendAgentTrace, drainAgentTrace } from ${JSON.stringify(traceModuleUrl)};
        appendAgentTrace({ kind: 'delayed-local-test', session_id: 'sess_delayed' });
        rmSync(process.env.TRACE_PARENT, { recursive: true, force: true });
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
        TRACE_PARENT: traceParent,
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

test('explicit trace path stays append-only across concurrent writers', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-agent-trace-multiwriter-test-'));
  const tracePath = join(dir, 'agent-trace.jsonl');
  const writerCount = 4;
  const rowsPerWriter = 20;
  try {
    // Start above the normal rotation threshold. An explicit shared sink must
    // retain this row in the live file while every child appends to it.
    writeFileSync(tracePath, `${JSON.stringify({
      kind: 'multiwriter-seed',
      session_id: 'sess_seed',
      payload: 'x'.repeat(10 * 1024 * 1024),
    })}\n`);
    const childSource = `
      import { appendAgentTrace, drainAgentTrace } from ${JSON.stringify(traceModuleUrl)};
      for (let i = 0; i < Number(process.env.ROWS_PER_WRITER); i += 1) {
        appendAgentTrace({
          kind: 'multiwriter',
          session_id: 'sess_writer_' + process.env.WRITER_ID,
          payload: { writer: Number(process.env.WRITER_ID), index: i },
        });
      }
      await drainAgentTrace();
    `;
    await Promise.all(Array.from({ length: writerCount }, (_, writer) => new Promise((resolveChild, rejectChild) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', childSource], {
        cwd: root,
        env: {
          ...process.env,
          MIXDOG_AGENT_TRACE_PATH: tracePath,
          MIXDOG_AGENT_TRACE_DISABLE: '',
          MIXDOG_AGENT_TRACE_LOCAL_DISABLE: '',
          MIXDOG_RUNTIME_ROOT: join(dir, `no-service-${writer}`),
          ROWS_PER_WRITER: String(rowsPerWriter),
          WRITER_ID: String(writer),
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', rejectChild);
      child.on('exit', (code) => {
        if (code === 0) resolveChild();
        else rejectChild(new Error(`writer ${writer} exited ${code}: ${stderr}`));
      });
    })));
    assert.equal(existsSync(`${tracePath}.1`), false);
    const rows = readFileSync(tracePath, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
    assert.equal(rows[0].kind, 'multiwriter-seed');
    const written = rows.filter((row) => row.kind === 'multiwriter');
    assert.equal(written.length, writerCount * rowsPerWriter);
    assert.deepEqual(
      [...new Set(written.map((row) => row.session_id))].sort(),
      Array.from({ length: writerCount }, (_, writer) => `sess_writer_${writer}`),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
