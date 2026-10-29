import assert from 'node:assert/strict';
import test from 'node:test';
import { GOAL_TOOL_DEFS } from '../runtime-core/goal-tool-defs.mjs';
import { toolSearchNativePayload } from '../runtime-core/tool-catalog.mjs';
import { nativeToolSearchOutputInput } from './custom-tool-wire.mjs';
import { toOpenAIResponsesTool } from './openai-responses-payload.mjs';
import { toResponsesTools } from './openai-compat-wire.mjs';

test('Responses function tools preserve optional Goal fields in direct and deferred loading', () => {
  const goal = GOAL_TOOL_DEFS[0];
  for (const wire of [
    toOpenAIResponsesTool(goal),
    ...toResponsesTools([goal], { provider: 'openai-oauth' }),
    ...['openai', 'openai-oauth'].flatMap(
      (provider) =>
        nativeToolSearchOutputInput(
          {
            toolCallId: 'goal-schema',
            nativeToolSearch: toolSearchNativePayload([goal], ['goal'], provider),
          },
          provider
        ).tools
    ),
  ]) {
    assert.equal(wire.strict, false);
    assert.deepEqual(wire.parameters.required, ['action']);
    // Per-action fields stay optional instead of turning into required nullables.
    assert.deepEqual(Object.keys(wire.parameters.properties).sort(), [
      'action',
      'blocker',
      'objective',
      'time_limit_minutes',
    ]);
    assert.equal(wire.parameters.properties.objective.type, 'string');
  }
});
