import assert from 'node:assert/strict';
import test from 'node:test';

import { SPINNER_MODE_OVERRIDE_VERBS } from '../spinner-verbs.mjs';

// Typed input waking a task wait is the queue's job (session-flow enqueue);
// see session/manager/task-wait-wake-matrix.slow.test.mjs.
test('task wait spinner has the dedicated waiting label', () => {
  assert.equal(SPINNER_MODE_OVERRIDE_VERBS['task-wait'], '작업 대기 중');
});
