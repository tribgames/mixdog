// Memory tool dispatch routing.
import './_env.mjs';
import test from 'node:test';
import { createToolCallHandler } from '../../src/runtime/memory/lib/tool-call-handler.mjs';

test('memory handler injects action=core for public schema calls', async () => {
  let dispatchedMemoryArgs = null;
  const dispatchMemoryToolCall = createToolCallHandler({
    handleSearch: async () => ({ text: '' }),
    handleMemoryAction: async (args) => {
      dispatchedMemoryArgs = args;
      return { text: 'ok' };
    },
  });
  await dispatchMemoryToolCall('memory', { op: 'list' });
  if (dispatchedMemoryArgs?.action !== 'core' || dispatchedMemoryArgs?.op !== 'list') {
    throw new Error(
      `memory handler must inject action=core for the public schema: ${JSON.stringify(dispatchedMemoryArgs)}`
    );
  }
  await dispatchMemoryToolCall('memory', { action: 'status' });
  if (dispatchedMemoryArgs?.action !== 'status') {
    throw new Error('memory handler must preserve internal status calls');
  }
});
