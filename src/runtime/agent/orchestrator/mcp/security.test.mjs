import assert from 'node:assert/strict';
import test from 'node:test';

import {
  mcpUrlForLog,
  normalizeMcpTransportUrl,
  resolveMcpHttpHeaders,
  resolveMcpStdioEnvironment,
  scrubMcpConnectionMessage,
} from './client.mjs';
test('MCP transport requires encryption except for loopback', () => {
  assert.equal(
    normalizeMcpTransportUrl('http://127.0.0.1:3000/mcp', 'http'),
    'http://127.0.0.1:3000/mcp',
  );
  assert.equal(
    normalizeMcpTransportUrl('ws://localhost:3000/mcp', 'ws'),
    'ws://localhost:3000/mcp',
  );
  assert.match(normalizeMcpTransportUrl('https://mcp.example/mcp', 'http'), /^https:/);
  assert.match(normalizeMcpTransportUrl('wss://mcp.example/mcp', 'ws'), /^wss:/);
  assert.throws(
    () => normalizeMcpTransportUrl('http://mcp.example/mcp', 'http'),
    /must use https/,
  );
  assert.throws(
    () => normalizeMcpTransportUrl('ws://mcp.example/mcp', 'ws'),
    /must use wss/,
  );
  assert.throws(
    () => normalizeMcpTransportUrl('https://user:secret@mcp.example/mcp', 'http'),
    /must not contain credentials/,
  );
});

test('MCP logs and failures redact URL and header credentials', () => {
  const secret = 'mcp-secret-value';
  const url = `https://mcp.example/mcp?token=${secret}`;
  assert.doesNotMatch(mcpUrlForLog(url), new RegExp(secret));
  const scrubbed = scrubMcpConnectionMessage(
    `failed ${url} Authorization: Bearer ${secret}`,
    { url, headers: { Authorization: `Bearer ${secret}` } },
  );
  assert.doesNotMatch(scrubbed, new RegExp(secret));
  assert.match(scrubbed, /redacted/);
});

test('MCP HTTP auth resolves from environment without storing secret values', () => {
  const headers = resolveMcpHttpHeaders({
    bearer_token_env_var: 'MCP_TOKEN',
    env_http_headers: { 'X-API-Key': 'MCP_API_KEY' },
    headers: { 'X-Static': '${MCP_STATIC}', Authorization: 'Explicit auth' },
  }, {
    MCP_TOKEN: 'bearer-secret',
    MCP_API_KEY: 'key-secret',
    MCP_STATIC: 'expanded',
  });
  assert.deepEqual(headers, {
    Authorization: 'Explicit auth',
    'X-API-Key': 'key-secret',
    'X-Static': 'expanded',
  });
});

test('MCP stdio passthrough narrows inherited environment only when configured', () => {
  const env = {
    PATH: '/bin',
    HOME: '/home/test',
    KEEP_ME: 'kept',
    DROP_ME: 'dropped',
  };
  assert.equal(resolveMcpStdioEnvironment({ env: { LOCAL: '${KEEP_ME}' } }, env).DROP_ME, 'dropped');
  const narrowed = resolveMcpStdioEnvironment({
    env_vars: ['KEEP_ME'],
    env: { LOCAL: '${KEEP_ME}' },
  }, env);
  assert.equal(narrowed.KEEP_ME, 'kept');
  assert.equal(narrowed.LOCAL, 'kept');
  assert.equal(narrowed.DROP_ME, undefined);
});
