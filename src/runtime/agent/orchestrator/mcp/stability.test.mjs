// MCP call stability: the configured per-call timeout (not the SDK's 60s
// default) bounds every request, progress keeps a call alive up to its total
// cap, a timed-out call is never reconnected/replayed, and our own timeout
// cancels only that request — the server and its other calls stay up.
import assert from 'node:assert/strict';
import test from 'node:test';
import { McpError } from '@modelcontextprotocol/sdk/types.js';

import {
  _registerMcpServerForTest,
  disconnectAll,
  executeMcpTool,
  getMcpServerStatus,
  resolveMcpStartupTimeoutMs,
} from './client.mjs';

process.env.MIXDOG_QUIET_MCP_LOG = '1';
const delay = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

test('the startup budget defaults to 30s', () => {
  assert.equal(resolveMcpStartupTimeoutMs({}, {}), 30000);
});

test('the SDK request receives the configured timeout, progress reset and total cap', async () => {
  const scopeId = 'mcp-stability-options';
  const seen = [];
  const record = async (_params, _schema, options) => {
    seen.push(options);
    return { content: [{ type: 'text', text: 'ok' }] };
  };
  _registerMcpServerForTest(scopeId, 'tuned', [{ name: 't' }], {
    cfg: { timeoutMs: 4321, maxTotalTimeoutMs: 9999 },
    callTool: record,
  });
  _registerMcpServerForTest(scopeId, 'unbounded', [{ name: 't' }], { cfg: { timeoutMs: 'off' }, callTool: record });
  _registerMcpServerForTest(scopeId, 'catalog', [], {
    cfg: { timeoutMs: 2500 },
    capabilities: { resources: {} },
    client: {
      listResources: async (_params, options) => {
        seen.push(options);
        return { resources: [] };
      },
    },
  });
  try {
    await executeMcpTool('mcp__tuned__t', {}, { scopeId });
    await executeMcpTool('mcp__unbounded__t', {}, { scopeId });
    await executeMcpTool('mcp__catalog__mixdog_list_resources', {}, { scopeId });
    const [tuned, unbounded, feature] = seen;
    assert.equal(tuned.timeout, 4321);
    assert.equal(tuned.maxTotalTimeout, 9999);
    assert.equal(tuned.resetTimeoutOnProgress, true);
    assert.equal(typeof tuned.onprogress, 'function');
    assert.ok(tuned.signal instanceof AbortSignal);
    // Disabled: the SDK's own 60s default must not apply either.
    assert.equal(unbounded.timeout, 2_147_483_647);
    assert.equal(unbounded.maxTotalTimeout, undefined);
    assert.equal(feature.timeout, 2500);
    assert.equal(feature.resetTimeoutOnProgress, true);
  } finally {
    await disconnectAll({ scopeId });
  }
});

test('progress reports keep a call alive past its per-call timeout', async () => {
  const scopeId = 'mcp-stability-progress';
  _registerMcpServerForTest(scopeId, 'slow', [{ name: 'work' }], {
    cfg: { timeoutMs: 400 },
    callTool: async (_params, _schema, options) => {
      for (let i = 0; i < 5; i += 1) {
        await delay(150);
        options.onprogress({ progress: i, total: 5 });
      }
      return { content: [{ type: 'text', text: 'done' }] };
    },
  });
  try {
    assert.equal(await executeMcpTool('mcp__slow__work', {}, { scopeId }), 'done');
  } finally {
    await disconnectAll({ scopeId });
  }
});

test('an SDK RequestTimeout (-32001) is neither reconnected nor replayed', async () => {
  const scopeId = 'mcp-stability-sdk-timeout';
  let calls = 0;
  let closes = 0;
  _registerMcpServerForTest(scopeId, 'late', [{ name: 'effect' }], {
    callTool: async () => {
      calls += 1;
      throw new McpError(-32001, 'Request timed out');
    },
    close: async () => {
      closes += 1;
    },
  });
  try {
    await assert.rejects(executeMcpTool('mcp__late__effect', {}, { scopeId }), /Request timed out/);
    assert.equal(calls, 1, 'never replayed');
    assert.equal(closes, 0, 'never reconnected');
  } finally {
    await disconnectAll({ scopeId });
  }
});

test('our timeout cancels only the timed-out request; a parallel call on the server survives', async () => {
  const scopeId = 'mcp-stability-own-timeout';
  let closes = 0;
  let cancelReason = null;
  const release = Promise.withResolvers();
  _registerMcpServerForTest(scopeId, 'shared', [{ name: 'hang' }, { name: 'ok' }], {
    cfg: { timeoutMs: 200 },
    callTool: ({ name }, _schema, options) => {
      if (name === 'ok') return release.promise;
      return new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          cancelReason = options.signal.reason;
          reject(new McpError(-32001, String(options.signal.reason)));
        });
      });
    },
    close: async () => {
      closes += 1;
    },
  });
  // The call deadline timer is unref'd; keep the loop alive while it runs.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    const hung = executeMcpTool('mcp__shared__hang', {}, { scopeId });
    hung.catch(() => {});
    await delay(100);
    const parallel = executeMcpTool('mcp__shared__ok', {}, { scopeId });
    await assert.rejects(hung, (error) => {
      assert.equal(error.code, 'EMCPTOOLTIMEOUT');
      assert.match(error.message, /timed out after 200ms/);
      return true;
    });
    assert.equal(cancelReason?.code, 'EMCPTOOLTIMEOUT', 'the timed-out request alone was cancelled');
    release.resolve({ content: [{ type: 'text', text: 'survived' }] });
    assert.equal(await parallel, 'survived');
    assert.equal(closes, 0, 'the server was never closed');
    assert.equal(getMcpServerStatus(scopeId)[0].connected, true);
  } finally {
    clearInterval(keepAlive);
    await disconnectAll({ scopeId });
  }
});
