/**
 * use-session-diff-revert.test.mjs — an open Session Diff re-reads which files
 * can still be reverted when a revert of that session lands anywhere else.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom } from './test-support/test-dom.mjs';
import { publishReviewInvalidation } from './review-invalidation.ts';
import { useSessionDiffRevert } from './use-session-diff-revert.ts';

const settle = () =>
  act(async () => {
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
  });

test('a revert published for the session drops the reverted file from the enabled Revert buttons', async (t) => {
  const view = installTestDom(t, { rootId: 'root' });
  let files = ['a.ts', 'b.ts'];
  let reads = 0;
  view.window.mixdogDesktop = {
    invokeCapability: async () => {
      reads += 1;
      return { value: { checkpointId: 'cp', files: files.map((path) => ({ path })) } };
    },
  };
  let state;
  function Probe({ sessionId }) {
    state = useSessionDiffRevert({
      sessionId,
      active: true,
      busy: false,
      reviewKey: 'k',
      refresh: async () => {},
      setRevertError() {},
    });
    return null;
  }
  await act(async () => view.root.render(React.createElement(Probe, { sessionId: 's1' })));
  await settle();
  assert.equal(state.canRevertPath('a.ts'), true);
  assert.equal(state.canRevertPath('b.ts'), true);

  files = ['b.ts'];
  await act(async () => publishReviewInvalidation('other-session'));
  await settle();
  assert.equal(reads, 1, 'another session’s revert does not re-read');
  assert.equal(state.canRevertPath('a.ts'), true);

  await act(async () => publishReviewInvalidation('s1'));
  await settle();
  assert.equal(reads, 2);
  assert.equal(state.canRevertPath('a.ts'), false, 'the reverted file is no longer revertable');
  assert.equal(state.canRevertPath('b.ts'), true);
});
