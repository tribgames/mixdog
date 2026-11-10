import assert from 'node:assert/strict';
import test from 'node:test';

import { CaptureService } from './capture-host.ts';

// The capture profile answers a new task itself (capture-host.ts `submitNewTask`, as at b6f10295a): no daemon, no core and no
// new-task receipt, so the submission id is not deduplicated there. Content the receipt gate would refuse under a reused id
// (`Submission id was reused for different content.`) is accepted.
test('the capture profile creates a new task without the receipt gate', async () => {
  const host = new CaptureService();
  const first = await host.submitNewTask({ text: 'write the report' }, { clientSubmissionId: 'sub-capture' }, {});
  const reused = await host.submitNewTask({ text: 'write another report' }, { clientSubmissionId: 'sub-capture' }, {});
  for (const result of [first, reused]) {
    assert.equal(result.accepted, true);
    assert.match(result.sessionId, /^capture_\d+$/);
    assert.equal(result.snapshot.sessionId, result.sessionId);
  }
});
