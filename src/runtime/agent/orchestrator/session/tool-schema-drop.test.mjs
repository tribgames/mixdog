// A provider 400 that names a tool schema must not brick the session: the tool
// is dropped for the session (with the notice) and the turn replays once.
import assert from 'node:assert/strict';
import test from 'node:test';
import { agentLoop } from './agent-loop.mjs';
import { rejectedToolSchema } from './tool-schema-rejection.mjs';
import { routeToolExclusionReason } from './loop/provider-tool-exclusions.mjs';

const lookup = { name: 'lookup', description: 'd', inputSchema: { type: 'object', properties: {} } };
const flaky = { name: 'mcp__x__flaky', description: 'd', inputSchema: { type: 'object', properties: {} } };
const status400 = (message) => Object.assign(new Error(message), { httpStatus: 400, status: 400 });

const MESSAGES = {
  anthropic: (index) => `Anthropic API error 400: tools.${index}.custom.input_schema: JSON schema is invalid. It must match JSON Schema draft 2020-12`,
  openai: () => "400 Invalid schema for function 'mcp__x__flaky': In context=('properties', 'a'), array schema missing items.",
  openaiIndex: (index) => `400 Invalid 'tools[${index}].parameters': schema must be a JSON Schema of 'type: "object"'`,
};

test('rejectedToolSchema names the tool a schema 400 points at, and nothing else', () => {
  const sendTools = [lookup, flaky];
  const ctx = { sendTools, sessionRef: {}, opts: {} };
  assert.equal(rejectedToolSchema(status400(MESSAGES.anthropic(1)), ctx).name, 'mcp__x__flaky');
  assert.equal(rejectedToolSchema(status400(MESSAGES.openai()), ctx).name, 'mcp__x__flaky');
  assert.equal(rejectedToolSchema(status400(MESSAGES.openaiIndex(1)), ctx).name, 'mcp__x__flaky');
  const hosted = { ...ctx, opts: { nativeTools: [{ type: 'web_search' }] } };
  assert.equal(rejectedToolSchema(status400(MESSAGES.openaiIndex(1)), hosted).name, 'lookup', 'hosted tools precede the functions');
  assert.equal(rejectedToolSchema(status400(MESSAGES.anthropic(0)), ctx).name, 'lookup');
  assert.equal(rejectedToolSchema(status400(MESSAGES.anthropic(7)), ctx), null, 'index outside the request');
  assert.equal(rejectedToolSchema(status400('messages.2: tool_use ids must be unique'), ctx), null, 'another 400');
  assert.equal(rejectedToolSchema(Object.assign(new Error(MESSAGES.anthropic(1)), { httpStatus: 500 }), ctx), null, 'not a 400');
});

test('rejectedToolSchema reads every supported path form, structured fields first', () => {
  const sendTools = [lookup, flaky];
  const ctx = { sendTools, sessionRef: {}, opts: {} };
  const named = (extra) => Object.assign(status400('Bad Request'), extra);
  const expectFlaky = (error, context = ctx) => assert.equal(rejectedToolSchema(error, context)?.name, 'mcp__x__flaky');
  // OpenAI message path forms.
  expectFlaky(status400("Invalid 'tools[1].function.parameters': bad"));
  expectFlaky(status400("Invalid 'tools.1.function.parameters': bad"));
  expectFlaky(status400("Invalid 'tools[1].parameters': bad"));
  expectFlaky(status400("Invalid schema for function \"mcp__x__flaky\": bad"));
  // Structured OpenAI fields (message names nothing).
  expectFlaky(named({ param: 'tools[1].function.parameters' }));
  expectFlaky(named({ error: { param: 'tools.1.function.parameters', message: 'Invalid schema' } }));
  expectFlaky(named({ error: { message: "Invalid schema for function 'mcp__x__flaky': bad" } }));
  expectFlaky(named({ body: JSON.stringify({ error: { param: 'tools[1].parameters' } }) }));
  expectFlaky(named({ responseBody: JSON.stringify({ error: { message: 'tools.1.custom.input_schema: JSON schema is invalid' } }) }));
  // Structured Anthropic fields.
  expectFlaky(named({ error: { type: 'invalid_request_error', message: 'tools.1.custom.input_schema: JSON schema is invalid' } }));
  expectFlaky(named({ error: { message: 'tools.1.input_schema: invalid' } }));
  // Structured Google fields and message forms.
  expectFlaky(named({ details: [{ fieldViolations: [{ field: 'tools[0].function_declarations[1].parameters', description: 'bad' }] }] }));
  expectFlaky(status400('Invalid JSON payload received. Unknown name at tools[0].function_declarations[1].parameters'));
  expectFlaky(status400('functionDeclarations[1].parameters schema invalid'));
  // Structured evidence wins over a vaguer message.
  expectFlaky(named({ param: 'tools[1].function.parameters', message: "Invalid schema for function 'lookup'" }));
  // Hosted tools precede the functions on Responses; chat has none.
  const hosted = { ...ctx, opts: { nativeTools: [{ type: 'web_search' }] } };
  assert.equal(rejectedToolSchema(named({ param: 'tools[1].parameters' }), hosted).name, 'lookup');
  assert.equal(rejectedToolSchema(named({ param: 'tools[2].parameters' }), hosted).name, 'mcp__x__flaky');
  // Nothing recognisable / not a 400 / out of range.
  assert.equal(rejectedToolSchema(named({ param: 'messages[0].content' }), ctx), null);
  assert.equal(rejectedToolSchema(named({ param: 'tools[9].parameters' }), ctx), null);
  assert.equal(rejectedToolSchema(Object.assign(new Error("Invalid schema for function 'lookup'"), { status: 429 }), ctx), null);
});

for (const [label, message] of [
  ['Anthropic index', (tools) => MESSAGES.anthropic(tools.findIndex((t) => t.name === flaky.name))],
  ['OpenAI function name', () => MESSAGES.openai()],
]) {
  test(`${label} 400: the tool is dropped with the notice, the turn replays once, later turns work`, async () => {
    const session = { owner: 'cli', provider: 'anthropic', compaction: { auto: false } };
    const notices = [];
    const requests = [];
    const provider = {
      async send(_messages, _model, tools) {
        requests.push((tools || []).map((t) => t.name));
        if ((tools || []).some((t) => t.name === flaky.name)) throw status400(message(tools));
        return { content: 'ok', toolCalls: [], stopReason: 'end_turn' };
      },
    };
    const run = () =>
      agentLoop(provider, [{ role: 'user', content: 'go' }], 'fake-model', [lookup, flaky], null, process.cwd(), {
        session,
        onStageChange: (stage, detail) => stage === 'notice' && notices.push(detail.message),
      });
    const first = await run();
    assert.equal(first.content, 'ok');
    assert.equal(requests.length, 2, 'one failed request and one retry');
    assert.ok(requests[0].includes(flaky.name));
    assert.ok(!requests[1].includes(flaky.name));
    assert.equal(notices.length, 1);
    assert.match(notices[0], /^Tool "mcp__x__flaky" was excluded/);
    assert.match(routeToolExclusionReason(session, flaky), /unavailable/);
    const second = await run();
    assert.equal(second.content, 'ok');
    assert.equal(requests.length, 3, 'the next turn sends once, without the tool');
    assert.ok(!requests[2].includes(flaky.name));
    assert.equal(notices.length, 1, 'told once per session');
  });
}

test('a 400 that does not name a tool schema behaves as before (no drop, no retry)', async () => {
  const session = { owner: 'cli', provider: 'anthropic', compaction: { auto: false } };
  let sends = 0;
  const provider = {
    async send() {
      sends += 1;
      throw status400('messages.0.content: Input should be a valid list');
    },
  };
  await assert.rejects(
    agentLoop(provider, [{ role: 'user', content: 'go' }], 'fake-model', [lookup, flaky], null, process.cwd(), { session }),
    /valid list/
  );
  assert.equal(sends, 1);
  assert.equal(routeToolExclusionReason(session, flaky), null);
});
