import assert from 'node:assert/strict';
import test from 'node:test';

import { browserOpenRequest, takeoverRevealDetail } from './page-reveal.ts';

test("a takeover's surface request names the handed-over page, and no page once it is gone", () => {
  const page = { getTitle: () => 'Sign in' };
  const pageIds = new Map([[page, 'p4']]);
  const detail = takeoverRevealDetail(page, (guest) => pageIds.get(guest));
  assert.deepEqual(browserOpenRequest('child', 'handoff', detail), {
    sessionId: 'child',
    reveal: true,
    handoff: true,
    tabId: 'p4',
    title: 'Sign in',
  });
  // The handed-over page closed: the request names none, never another tab.
  assert.deepEqual(
    browserOpenRequest(
      'child',
      'handoff',
      takeoverRevealDetail(null, () => 'p1')
    ),
    {
      sessionId: 'child',
      reveal: true,
      handoff: true,
    }
  );
});
