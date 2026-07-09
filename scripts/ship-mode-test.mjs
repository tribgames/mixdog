import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const debug = require('../src/lib/mixdog-debug.cjs');

const MODE_ENVS = [
  'MIXDOG_MODE',
  'MIXDOG_SHIP',
  'MIXDOG_DIAGNOSTICS',
  'MIXDOG_DEBUG',
  'MIXDOG_DEBUG_SESSION_START',
  'MIXDOG_AGENT_TRACE_LOCAL_DISABLE',
  'MIXDOG_AGENT_TRACE_PATH',
  'MIXDOG_TOOL_FAILURE_LOG_DISABLE',
  'MIXDOG_TOOL_FAILURE_LOG_PATH',
];

function withEnv(overrides, fn) {
  const prev = {};
  for (const k of MODE_ENVS) prev[k] = process.env[k];
  for (const k of MODE_ENVS) delete process.env[k];
  for (const [k, v] of Object.entries(overrides)) process.env[k] = v;
  try { return fn(); }
  finally {
    for (const k of MODE_ENVS) {
      if (prev[k] == null) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

test('MIXDOG_MODE=ship forces shipping mode with diagnostics off', () => {
  withEnv({ MIXDOG_MODE: 'ship' }, () => {
    assert.equal(debug.resolveMixdogMode(), 'ship');
    assert.equal(debug.isShippingMode(), true);
    assert.equal(debug.isDevMode(), false);
    assert.equal(debug.isDiagnosticIOEnabled(), false);
  });
});

test('MIXDOG_MODE=dev forces dev mode with diagnostics on', () => {
  withEnv({ MIXDOG_MODE: 'dev' }, () => {
    assert.equal(debug.resolveMixdogMode(), 'dev');
    assert.equal(debug.isDiagnosticIOEnabled(), true);
  });
});

test('MIXDOG_DEBUG implies dev mode', () => {
  withEnv({ MIXDOG_MODE: 'ship', MIXDOG_DEBUG: '1' }, () => {
    // explicit MIXDOG_MODE=ship still wins over debug flag by precedence
    assert.equal(debug.resolveMixdogMode(), 'ship');
  });
  withEnv({ MIXDOG_DEBUG: '1' }, () => {
    assert.equal(debug.resolveMixdogMode(), 'dev');
    assert.equal(debug.isDiagnosticIOEnabled(), true);
  });
});

test('MIXDOG_DIAGNOSTICS force-enables diagnostic IO under shipping', () => {
  withEnv({ MIXDOG_MODE: 'ship', MIXDOG_DIAGNOSTICS: '1' }, () => {
    assert.equal(debug.isShippingMode(), true);
    assert.equal(debug.isDiagnosticIOEnabled(), true);
  });
});

test('shipping mode suppresses default diagnostic file paths', async () => {
  const io = await import('../src/runtime/agent/orchestrator/agent-trace-io.mjs?ship-default');
  withEnv({ MIXDOG_MODE: 'ship' }, () => {
    assert.equal(io._resolveLocalTracePath(), null);
    assert.equal(io._resolveToolFailurePath(), null);
  });
});

test('explicit diagnostic file paths opt in under shipping mode', async () => {
  const io = await import('../src/runtime/agent/orchestrator/agent-trace-io.mjs?ship-explicit-path');
  const base = join(tmpdir(), `mixdog-ship-mode-test-${process.pid}`);
  const tracePath = join(base, 'explicit-agent-trace.jsonl');
  const failuresPath = join(base, 'explicit-tool-failures.jsonl');
  withEnv({
    MIXDOG_MODE: 'ship',
    MIXDOG_AGENT_TRACE_PATH: tracePath,
    MIXDOG_TOOL_FAILURE_LOG_PATH: failuresPath,
  }, () => {
    assert.equal(io._resolveLocalTracePath(), tracePath);
    assert.equal(io._resolveToolFailurePath(), failuresPath);
  });
});

test('git checkout default stays dev for local diagnostics', () => {
  withEnv({}, () => {
    assert.equal(debug.resolveMixdogMode(), 'dev');
    assert.equal(debug.isDiagnosticIOEnabled(), true);
  });
});
