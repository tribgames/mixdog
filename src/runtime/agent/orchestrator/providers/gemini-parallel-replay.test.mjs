import test from 'node:test';
import assert from 'node:assert/strict';
import { toGeminiContents } from './gemini-schema.mjs';
import { buildAntigravityRequest } from './antigravity-request.mjs';
import { createProviderReplay } from './lib/provider-replay.mjs';

for (const provider of ['gemini', 'antigravity']) {
  for (const serverIds of [false, true]) {
    test(`${provider}: reversed parallel results retain call order over consecutive same-tool steps (ids=${serverIds})`, () => {
      const model = 'gemini-3.8-flash';
      const messages = [{ role: 'user', content: 'Read both files twice.' }];
      const originalParts = [];
      for (const step of [1, 2]) {
        const calls = ['a', 'b'].map((name) => ({
          id: `${step}-${name}`,
          name: 'read',
          arguments: { file_path: `${name}.txt` },
        }));
        const parts = calls.map((call, index) => ({
          functionCall: {
            name: call.name,
            args: call.arguments,
            ...(serverIds ? { id: `wire-${call.id}` } : {}),
          },
          ...(index === 0 ? { thoughtSignature: `opaque-${step}` } : {}),
        }));
        originalParts.push(structuredClone(parts));
        messages.push({
          role: 'assistant',
          content: '',
          toolCalls: calls,
          providerReplay: { ...createProviderReplay(provider, parts), requestContext: { model } },
        });
        messages.push(
          { role: 'tool', toolCallId: calls[1].id, toolKind: 'error', content: `error-${step}-b` },
          { role: 'tool', toolCallId: calls[0].id, content: `ok-${step}-a` }
        );
      }
      const original = structuredClone(messages);
      const contents =
        provider === 'gemini'
          ? toGeminiContents(messages, model)
          : buildAntigravityRequest(messages, model, [], {}, 'fixture').request.contents;
      const turns = contents.filter((content) => content.parts.some((part) => part.functionResponse));
      assert.equal(turns.length, 2);
      for (const [index, turn] of turns.entries()) {
        const step = index + 1;
        assert.deepEqual(
          turn.parts.map((part) => part.functionResponse.response),
          [{ result: `ok-${step}-a` }, { error: `error-${step}-b` }]
        );
        assert.deepEqual(
          turn.parts.map((part) => part.functionResponse.id),
          serverIds ? [`wire-${step}-a`, `wire-${step}-b`] : [undefined, undefined]
        );
        assert.deepEqual(
          turn.parts.map((part) => part.functionResponse.name),
          ['read', 'read']
        );
      }
      assert.deepEqual(
        contents.filter((content) => content.role === 'model').map((content) => content.parts),
        originalParts
      );
      assert.deepEqual(messages, original, 'conversion must not mutate transcript or replay');
    });
  }
}
