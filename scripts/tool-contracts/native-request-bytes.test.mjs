// Native (anthropic*, openai*) sessions see exactly the request bytes HEAD
// d2c3e672c sent before the tool bridge: tool definitions, wire tools, the
// system prompt with its BP2 roster and MCP instructions, load_tool results,
// late-MCP notices, skill loading text, deny texts and provider switches.
// The expected values were generated from that HEAD checkout by
// native-request-bytes-scenarios.mjs (see its header to regenerate).
import { root } from './_env.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nativeRequestScenarios } from './native-request-bytes-scenarios.mjs';

const fixture = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'native-request-bytes.head.json'), 'utf8')
);

test('native request bytes equal the pre-bridge HEAD output', async () => {
  const actual = await nativeRequestScenarios(root, fixture.catalog);
  for (const provider of Object.keys(fixture.expected)) {
    for (const [scenario, expected] of Object.entries(fixture.expected[provider])) {
      assert.deepEqual(actual[provider]?.[scenario], expected, `${provider} ${scenario}`);
    }
  }
  assert.deepEqual(Object.keys(actual), Object.keys(fixture.expected));
});

test('the HEAD fixture exercises every native-visible path', () => {
  for (const scenario of Object.values(fixture.expected)) {
    const bp2 = scenario.first.system[1];
    assert.match(bp2, /<available-deferred-tools>/);
    assert.match(bp2, /<mcp-instructions>/);
    assert.ok(scenario.first.tools.some(([name]) => name === 'load_tool'));
    assert.ok(scenario.afterLoad.tools.length > scenario.first.tools.length || scenario.afterLoad.state.discovered.length);
    assert.match(scenario.lateMcp.connected.content, /mcp__late__lookup/);
    assert.match(scenario.firstTurnFold.system[1], /mcp__late__lookup/);
    assert.match(scenario.skillLoading.text, /office/);
    for (const text of Object.values(scenario.denials)) assert.equal(typeof text === 'string' || text === null, true);
    assert.match(scenario.denials.unresolvedMode, /load it with load_tool/);
  }
});
