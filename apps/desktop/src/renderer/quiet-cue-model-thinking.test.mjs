import assert from 'node:assert/strict';
import test from 'node:test';

import { quietCueText } from './quiet-cue';

test('a quiet wait for headers says the model is thinking', () => {
  const text = quietCueText({ quietMs: 180_000, minutes: 3, wait: 'thinking', tool: '', escalated: false });
  assert.match(text, / · model thinking$/);
});
