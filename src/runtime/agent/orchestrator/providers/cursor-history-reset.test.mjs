import assert from 'node:assert/strict';
import test from 'node:test';
import { CursorOAuthProvider } from './cursor.mjs';

test('Cursor forwards intentional history resets to its parked-run transport', async () => {
  const provider = new CursorOAuthProvider();
  for (const intent of [undefined, 'automatic_compaction', 'manual_compaction', 'transcript_rebuild']) {
    let reset;
    const runtime = {
      async handleChatCompletion(_body, _token, options) {
        reset = options.resetActiveRun;
        throw new Error('transport probe');
      },
    };
    await assert.rejects(
      provider._dispatchChat({}, { runtime, accessToken: 'local-test-token', sendOpts: { cacheBreakIntent: intent } }),
      /transport probe/
    );
    assert.equal(reset, Boolean(intent));
  }
});
