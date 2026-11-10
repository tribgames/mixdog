// The TUI app's `/mcp login` flow against what Node's own modules (b6f10295a) did for the same sign-in runtimes,
// composed with Node's session extensions API: the prompt the flow opens and the full sequence of notices
// (node-oracle/record.mjs, `composed`). That API posted "mcp sign-in started: <name>" itself, right after a begin call
// answered `pending` and before the caller went on to post its own sign-in URL notice. In this tree the CORE posts that
// notice (branch `mcp-login-notice` of mixdogd), so the protocol stub below posts it at that point in that shape; the
// recorded order of it against the TUI's own notices is what is proven.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { MCP_FLOWS, runMcpFlow } from '../node-oracle/cases.mjs';
import { submitProviderPrompt } from '../prompt-submit/provider-prompts.mjs';
import { createMcpLogin } from './mcp-login.mjs';

const golden = JSON.parse(readFileSync(new URL('../node-oracle/node-oracle.golden.json', import.meta.url), 'utf8'));

/** The session over the protocol: the runtime's sign-in actions, and the core's start notice after a pending begin. */
function protocolStore(runtime, pushNotice) {
  return {
    ...runtime,
    pushNotice,
    beginMcpOAuthLogin: async (name, options) => {
      const result = await runtime.beginMcpOAuthLogin(name, options);
      if (result?.state === 'pending') pushNotice(`mcp sign-in started: ${name}`, 'info');
      return result;
    },
  };
}

for (const flow of MCP_FLOWS) {
  test(`the /mcp login flow equals Node's, notice for notice: ${flow.name}`, async () => {
    const recorded = golden.flows.find((f) => f.name === flow.name);
    const observed = await runMcpFlow(flow, { createMcpLogin, submitProviderPrompt, makeStore: protocolStore });
    assert.deepEqual(observed, recorded.composed);
    // Exactly one completion notice at most, and no notice carries the pasted code.
    assert.ok(observed.notices.filter(([text]) => /complete/i.test(text)).length <= 1);
    assert.ok(observed.notices.every(([text]) => !text.includes('code=')));
  });
}

test('the core\'s start notice comes before the TUI\'s sign-in URL notice, as in Node', () => {
  const [first] = golden.flows;
  assert.deepEqual(first.composed.notices.slice(0, 2), [
    ['mcp sign-in started: srv', 'info'],
    ['Sign in to srv: https://auth.example/a', 'info'],
  ]);
});
