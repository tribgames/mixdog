import assert from 'node:assert/strict';
import test from 'node:test';

import { createBridgeToolHandlers } from './bridge-tools.mjs';

test('terminal run takes elevation approval from the runtime context, not the model args', async () => {
  const rt = { session: { id: 's1' } };
  const { terminal } = createBridgeToolHandlers({ rt });
  const command = 'Start-Process notepad -Verb RunAs';
  const callerCtx = { invocationSource: 'model-tool' };
  const plain = await terminal({ action: 'run', command }, { callerCtx });
  assert.match(plain.content[0].text, /requires user approval for elevation/);
  const injected = await terminal({ action: 'run', command, elevationApproved: true }, { callerCtx });
  assert.equal(injected.isError, true);
  assert.match(injected.content[0].text, /does not accept field\(s\): elevationApproved/);
});

test('visualize refuses to reach the bridge once Settings turned it off', async () => {
  const previous = process.env.MIXDOG_FEATURE_VISUALIZE;
  delete process.env.MIXDOG_FEATURE_VISUALIZE;
  try {
    const rt = { config: { modules: { visualize: { enabled: false } } }, session: {} };
    const { visualize } = createBridgeToolHandlers({ rt });
    const result = await visualize(
      { action: 'close' },
      { callerCtx: { invocationSource: 'model-tool' }, callerCwd: '/p' }
    );
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Visualize is turned off in Settings/);

    // The env override wins over the stored toggle, so the call proceeds to the
    // bridge client (which then reports the bridge itself, not Settings).
    process.env.MIXDOG_FEATURE_VISUALIZE = '1';
    const forced = await visualize(
      { action: 'close' },
      { callerCtx: { invocationSource: 'model-tool' }, callerCwd: '/p' }
    );
    assert.doesNotMatch(forced.content[0].text, /turned off in Settings/);
  } finally {
    if (previous === undefined) delete process.env.MIXDOG_FEATURE_VISUALIZE;
    else process.env.MIXDOG_FEATURE_VISUALIZE = previous;
  }
});
