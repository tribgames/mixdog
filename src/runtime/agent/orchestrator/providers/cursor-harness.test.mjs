import assert from 'node:assert/strict';
import http2 from 'node:http2';
import { once } from 'node:events';
import test from 'node:test';

import { prepareCursorToolDefinition } from './cursor-wire-guards.mjs';
import { decodeMessage } from './cursor-wire-protobuf.mjs';

function queue() {
  const values = [];
  let resolve = null;
  return {
    push(value) {
      if (!resolve) values.push(value);
      else {
        const next = resolve;
        resolve = null;
        next(value);
      }
    },
    async next() {
      if (values.length) return values.shift();
      return new Promise((next) => {
        resolve = next;
      });
    },
  };
}

const description =
  'Read a known file.\n\n' +
  'Keep the supplied path unchanged. Preserve the requested offset and limit. ' +
  'Never substitute another file or search when an exact path was supplied.';
const readTool = {
  type: 'function',
  function: {
    name: 'read',
    description,
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Exact approved path; do not substitute.' },
      },
      required: ['file_path'],
    },
  },
};

test('Cursor preserves tool guidance, including nested schemas, without mutating the source', () => {
  const input = structuredClone(readTool);
  input.function.parameters.properties.options = {
    type: 'array',
    items: { type: 'string', description: 'Keep each option exactly as supplied.' },
  };
  const before = structuredClone(input);
  const prepared = prepareCursorToolDefinition(input);
  assert.equal(prepared.description, description);
  assert.equal(prepared.inputSchema.properties.file_path.description, 'Exact approved path; do not substitute.');
  assert.equal(prepared.inputSchema.properties.options.items.description, 'Keep each option exactly as supplied.');
  assert.deepEqual(input, before);
});

test('Cursor action context decodes the documented field numbers', () => {
  // UserMessageAction/ResumeAction field 2 -> RequestContext field 16.
  const context = Buffer.from([0x12, 0x04, 0x82, 0x01, 0x01, 0x78]);
  assert.equal(decodeMessage('UserMessageAction', context).requestContext.cloudRule, 'x');
  assert.equal(decodeMessage('ResumeAction', context).requestContext.cloudRule, 'x');
});

test('Cursor injects the harness up front and only rebuilds changed live contracts', { timeout: 15_000 }, async (t) => {
  const server = http2.createServer();
  const sessions = new Set();
  const connections = queue();
  server.on('session', (session) => {
    sessions.add(session);
    session.on('close', () => sessions.delete(session));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const previousUrl = process.env.CURSOR_API_URL;
  process.env.CURSOR_API_URL = `http://127.0.0.1:${server.address().port}`;
  let runtime;
  try {
    runtime = await import('./cursor-wire.mjs?cursor-harness-test');
  } finally {
    if (previousUrl === undefined) delete process.env.CURSOR_API_URL;
    else process.env.CURSOR_API_URL = previousUrl;
  }
  const wire = runtime.__cursorWireInternals;
  t.after(async () => {
    globalThis.__mixdogDrainProviderConnections('cursor-harness-test');
    for (const session of sessions) session.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  server.on('stream', (stream) => {
    const messages = queue();
    stream.respond({ ':status': 200, 'content-type': 'application/connect+proto' });
    stream.on(
      'data',
      wire.createFrameParser(
        (bytes) => {
          const message = wire.decodeMessage('AgentClientMessage', bytes);
          if (!message.clientHeartbeat) messages.push(message);
        },
        () => {}
      )
    );
    connections.push({
      messages,
      send(message) {
        stream.write(wire.connectFrame(wire.encodeMessage('AgentServerMessage', message)));
      },
      finish() {
        stream.write(
          wire.connectFrame(
            wire.encodeMessage('AgentServerMessage', {
              interactionUpdate: { turnEnded: {} },
            })
          )
        );
        stream.end(wire.connectFrame(Buffer.from('{}'), 2));
      },
    });
  });

  const initialBody = (session) => ({
    model: 'cursor-harness-test',
    mixdog_session_id: session,
    messages: [
      { role: 'system', content: 'Follow the Mixdog harness.' },
      { role: 'developer', content: 'Keep the approved scope.' },
      { role: 'user', content: 'Read the requested file.' },
    ],
    tools: [structuredClone(readTool)],
  });
  const continueBody = (body) => ({
    ...body,
    messages: [
      ...body.messages,
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          {
            id: 'read-call',
            type: 'function',
            function: { name: 'read', arguments: '{"file_path":"approved.txt"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'read-call', content: 'Committed file contents.' },
    ],
  });
  const park = async (body) => {
    const response = await runtime.handleChatCompletion(body, 'local-test-token');
    const connection = await connections.next();
    const { runRequest } = await connection.messages.next();
    const context = runRequest.action.userMessageAction.requestContext;
    assert.equal(context.cloudRule, 'Follow the Mixdog harness.\n\nKeep the approved scope.');
    assert.equal(context.tools[0].description, description);
    assert.equal(
      JSON.parse(context.tools[0].inputSchemaJson).properties.file_path.description,
      'Exact approved path; do not substitute.'
    );
    assert.equal(context.mcpInstructions[0].serverName, 'mixdog');
    assert.equal(runRequest.customSystemPrompt, undefined);
    assert.equal(runRequest.mcpTools, undefined);
    assert.deepEqual(
      wire.decodeMessage('ConversationStateStructure', runRequest.conversationState).rootPromptMessagesJson || [],
      []
    );
    connection.send({ execServerMessage: { id: 1, execId: 'context', requestContextArgs: {} } });
    const reply = await connection.messages.next();
    assert.deepEqual(reply.execClientMessage.requestContextResult.success.requestContext, context);
    connection.send({
      execServerMessage: {
        id: 2,
        execId: 'read-exec',
        mcpArgs: {
          name: 'read',
          toolName: 'read',
          toolCallId: 'read-call',
          args: { file_path: wire.encodeJsonValue('approved.txt') },
        },
      },
    });
    connection.send({ interactionUpdate: { stepCompleted: {} } });
    assert.match(await response.text(), /"finish_reason":"tool_calls"/);
    return connection;
  };

  await t.test('equivalent schema representations reuse the connection and return each result once', async () => {
    const body = initialBody('unchanged-harness');
    const connection = await park(body);
    const next = continueBody(body);
    next.tools = [
      {
        ...readTool,
        function: {
          ...readTool.function,
          parameters: {
            required: ['file_path'],
            properties: { file_path: { description: 'Exact approved path; do not substitute.', type: 'string' } },
            type: 'object',
          },
        },
      },
    ];
    const response = await runtime.handleChatCompletion(next, 'local-test-token');
    const reply = await connection.messages.next();
    assert.equal(reply.runRequest, undefined);
    assert.equal(reply.execClientMessage.execId, 'read-exec');
    assert.equal(reply.execClientMessage.mcpResult.success.content[0].text.text, 'Committed file contents.');
    connection.finish();
    assert.match(await response.text(), /"finish_reason":"stop"/);
  });

  for (const change of ['rules', 'tools', 'tool-choice', 'model-parameters', 'max-mode']) {
    await t.test(`${change} changes rebuild with current context and committed history`, async () => {
      const body = initialBody(`changed-${change}`);
      await park(body);
      const next = continueBody(body);
      if (change === 'rules') next.messages[0] = { role: 'system', content: 'Use the updated Mixdog harness.' };
      if (change === 'tools')
        next.tools = [
          {
            type: 'function',
            function: { name: 'grep', description: 'Search the approved file.', parameters: { type: 'object' } },
          },
        ];
      if (change === 'tool-choice') next.tool_choice = 'none';
      if (change === 'model-parameters') next.mixdog_model_parameters = [{ id: 'effort', value: 'high' }];
      if (change === 'max-mode') next.mixdog_max_mode = true;
      const response = await runtime.handleChatCompletion(next, 'local-test-token');
      const connection = await connections.next();
      const { runRequest } = await connection.messages.next();
      const context = runRequest.action.resumeAction.requestContext;
      assert.equal(
        context.cloudRule,
        next.messages
          .slice(0, 2)
          .map((message) => message.content)
          .join('\n\n')
      );
      assert.deepEqual(
        (context.tools || []).map((tool) => tool.name),
        change === 'tool-choice' ? [] : next.tools.map((tool) => tool.function.name)
      );
      assert.deepEqual(runRequest.requestedModel.parameters || [], next.mixdog_model_parameters || []);
      assert.equal(runRequest.requestedModel.maxMode === true, next.mixdog_max_mode === true);
      if (change === 'tool-choice') assert.equal(context.mcpInstructions, undefined);
      const state = wire.decodeMessage('ConversationStateStructure', runRequest.conversationState);
      const history = [];
      for (const [id, blobId] of state.rootPromptMessagesJson.entries()) {
        connection.send({ kvServerMessage: { id, getBlobArgs: { blobId } } });
        const reply = await connection.messages.next();
        history.push(JSON.parse(new TextDecoder().decode(reply.kvClientMessage.getBlobResult.blobData)));
      }
      assert.deepEqual(
        history.map((entry) => entry.role),
        ['user', 'assistant', 'tool']
      );
      assert.equal(history[1].content[0].toolCallId, 'read-call');
      assert.equal(history[2].content[0].result, 'Committed file contents.');
      connection.finish();
      assert.match(await response.text(), /"finish_reason":"stop"/);
    });
  }
});
