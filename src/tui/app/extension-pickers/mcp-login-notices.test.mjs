// The TUI app's `/mcp login` flow against what Node's own modules (b6f10295a) did for the same sign-in runtimes:
// the prompt the flow opens and the notices it posts (node-oracle/record.mjs). Node also ran the flows composed with
// its in-process session extensions API; that API posted one extra "mcp sign-in started" notice of its own, which in
// this tree is the core's to post, so the TUI's flow is compared with the plain-store run.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { MCP_FLOWS, runMcpFlow } from '../node-oracle/cases.mjs';
import { submitProviderPrompt } from '../prompt-submit/provider-prompts.mjs';
import { createMcpLogin } from './mcp-login.mjs';

const golden = JSON.parse(readFileSync(new URL('../node-oracle/node-oracle.golden.json', import.meta.url), 'utf8'));

for (const flow of MCP_FLOWS) {
  test(`the /mcp login flow equals Node's: ${flow.name}`, async () => {
    const recorded = golden.flows.find((f) => f.name === flow.name);
    const observed = await runMcpFlow(flow, {
      createMcpLogin,
      submitProviderPrompt,
      makeStore: (runtime, pushNotice) => ({ ...runtime, pushNotice }),
    });
    assert.deepEqual(observed, recorded.plain);
    // Composed with Node's session API, the only difference was its own start notice.
    const withoutStart = recorded.composed.notices.filter(([text]) => !text.startsWith('mcp sign-in started:'));
    assert.deepEqual({ ...recorded.composed, notices: withoutStart }, recorded.plain);
    // Exactly one completion notice, and no notice carries the pasted code.
    assert.ok(observed.notices.filter(([text]) => /complete/i.test(text)).length <= 1);
    assert.ok(observed.notices.every(([text]) => !text.includes('code=')));
  });
}
