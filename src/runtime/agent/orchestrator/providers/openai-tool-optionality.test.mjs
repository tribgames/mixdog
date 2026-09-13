import assert from 'node:assert/strict';
import test from 'node:test';
import { GOAL_TOOL_DEFS } from '../../../../session-runtime/goal-tool-defs.mjs';
import { toolSearchNativePayload } from '../../../../session-runtime/tool-catalog.mjs';
import { nativeToolSearchOutputInput } from './custom-tool-wire.mjs';
import { toOpenAIResponsesTool } from './openai-responses-payload.mjs';
import { toResponsesTools } from './openai-compat-wire.mjs';

test('Responses function tools preserve optional Goal fields in direct and deferred loading', () => {
  const goal = GOAL_TOOL_DEFS[0];
  for (const wire of [
    toOpenAIResponsesTool(goal),
    ...toResponsesTools([goal], { provider: 'openai-oauth' }),
    ...['openai', 'openai-oauth'].flatMap(provider => nativeToolSearchOutputInput({
      toolCallId: 'goal-schema',
      nativeToolSearch: toolSearchNativePayload([goal], ['goal'], provider),
    }, provider).tools),
  ]) {
    assert.equal(wire.strict, false);
    assert.deepEqual(wire.parameters.required, ['action']);
    assert.equal(wire.parameters.properties.tasks.items.required.includes('id'), false);
    assert.deepEqual(wire.parameters.properties.updates.items.required, ['id']);
  }
});
