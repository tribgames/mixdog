import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  mcpUrlForLog,
  normalizeMcpTransportUrl,
  scrubMcpConnectionMessage,
} from './client.mjs';
import { readProjectMcpServers } from '../../../../session-runtime/plugin-mcp.mjs';

test('configured project MCP remains enabled by default', () => {
  const root = mkdtempSync(join(tmpdir(), 'mixdog-mcp-on-'));
  try {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, '.mcp.json'), JSON.stringify({
      mcpServers: { demo: { command: 'node', args: ['server.mjs'] } },
    }));
    const configured = readProjectMcpServers(root);
    assert.equal(configured.demo.command, 'node');
    assert.notEqual(configured.demo.enabled, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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
