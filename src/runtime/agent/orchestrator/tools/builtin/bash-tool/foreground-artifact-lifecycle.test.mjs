import '../../lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { mock } from 'node:test';

// Only execution and the invocation plan are scripted: the hoist, rendering
// and artifact cleanup of the shell tool run as they do for a real command.
let result = null;
let invocation = null;
let teePlan = null;
mock.module('../../shell-command.mjs', {
  namedExports: {
    execShellCommand: async (input) => {
      invocation = input;
      return result;
    },
    stripAnsi: (text) => text,
  },
});
mock.module('./command-preflight.mjs', {
  namedExports: {
    prepareShellCommand: ({ command }) => ({ command, analysisCommand: command, resolvedSpec: { shellType: 'posix' } }),
  },
});
mock.module('./invocation-plan.mjs', {
  namedExports: {
    planShellInvocation: async ({ command }) => ({ wrappedCommand: command, teePlan }),
  },
});

const { executeBashTool } = await import('../bash-tool.mjs');

const flush = () => new Promise((resolve) => setImmediate(resolve));

// A kill whose tree may still run: the result settles only once it is gone.
function killedResult() {
  let finish;
  const settled = new Promise((resolve) => {
    finish = resolve;
  });
  return {
    result: { stdout: '', stderr: '', exitCode: null, signal: 'SIGKILL', killed: true, settled },
    finish,
  };
}

test('a killed command keeps its hoisted script until its tree settles', async (t) => {
  const killed = killedResult();
  result = killed.result;
  teePlan = null;
  await executeBashTool({ command: 'node -e "console.log(1)"' }, process.cwd());
  const script = /"([^"]+)"\s*$/.exec(invocation.command)?.[1];
  assert.ok(script, `the command ran from a hoisted script file: ${invocation.command}`);
  t.after(() => rmSync(script, { force: true }));
  await flush();
  assert.equal(existsSync(script), true, 'a process of the killed tree may still read it');
  assert.equal(readFileSync(script, 'utf8'), 'console.log(1)');
  killed.finish();
  await flush();
  assert.equal(existsSync(script), false, 'the settled tree releases it');
});

test('a deferred hoisted script is removed at host exit when its tree never settles', (t) => {
  // A separate host: the same scripted execution, a tree whose observation
  // never ends, then the daemon exits.
  const url = (path) => JSON.stringify(new URL(path, import.meta.url).href);
  const out = execFileSync(
    process.execPath,
    [
      '--experimental-test-module-mocks',
      '--input-type=module',
      '-e',
      `
      import ${url('../../lib/isolated-test-env.mjs')};
      import { mock } from 'node:test';
      let invocation;
      mock.module(${url('../../shell-command.mjs')}, { namedExports: {
        execShellCommand: async (input) => {
          invocation = input;
          return { stdout: '', stderr: '', exitCode: null, signal: 'SIGKILL', killed: true, settled: new Promise(() => {}) };
        },
        stripAnsi: (text) => text,
      } });
      mock.module(${url('./command-preflight.mjs')}, { namedExports: {
        prepareShellCommand: ({ command }) => ({ command, analysisCommand: command, resolvedSpec: { shellType: 'posix' } }),
      } });
      mock.module(${url('./invocation-plan.mjs')}, { namedExports: {
        planShellInvocation: async ({ command }) => ({ wrappedCommand: command, teePlan: null }),
      } });
      const { executeBashTool } = await import(${url('../bash-tool.mjs')});
      await executeBashTool({ command: 'node -e "console.log(1)"' }, process.cwd());
      process.stdout.write(/"([^"]+)"\\s*$/.exec(invocation.command)?.[1] || '');
      process.exit(0);
    `,
    ],
    { timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  const script = String(out).trim();
  assert.ok(script, 'the command ran from a hoisted script file');
  t.after(() => rmSync(script, { force: true }));
  assert.equal(existsSync(script), false, 'the exit hook removes what is still pending');
});

test('a killed command reads its tee diagnostic but keeps the capture until its tree settles', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mixdog-fg-tee-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const teePath = join(dir, 'producer.log');
  writeFileSync(teePath, 'producer diagnostic\n');
  const killed = killedResult();
  result = killed.result;
  teePlan = { teePath };
  const rendered = await executeBashTool({ command: 'node producer.js | Select-String missing' }, process.cwd());
  assert.match(JSON.stringify(rendered), /producer diagnostic/);
  await flush();
  assert.equal(existsSync(teePath), true, 'the producer may still be writing it');
  killed.finish();
  await flush();
  assert.equal(existsSync(teePath), false);
});
