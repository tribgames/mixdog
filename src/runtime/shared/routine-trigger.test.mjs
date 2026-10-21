import assert from 'node:assert/strict';
import test from 'node:test';
import { routineTriggerHeader, stripRoutineTriggerHeader } from './routine-trigger.mjs';

test('the routine header carries the local time and the whole routine conduct on one line', () => {
  const header = routineTriggerHeader({
    kind: 'schedule',
    name: 'Morning',
    project: '/repo',
    now: Date.UTC(2026, 9, 21, 1, 26),
  });
  assert.match(header, /^\[Routine trigger\] Your schedule "Morning" fired\. /);
  assert.match(header, / Local time: \d{4}-\d{2}-\d{2} \d{2}:\d{2} \S+ \(UTC[+-]\d{2}:\d{2}\)\. /);
  assert.match(header, /nothing asks for approval: act within your permissions\./);
  assert.match(
    header,
    /Payments and permanent deletes are refused here: report that and suggest doing it from the chat\./
  );
  assert.doesNotMatch(header, /approvals wait/);
  assert.match(header, /If a sign-in, code or CAPTCHA blocks you, stop and say which site needs the user/);
  assert.match(header, /in plain words, without tool names/);
  assert.match(header, /if you handed work off, say it started — its result arrives here later\./);
  assert.match(header, / Project folder: \/repo$/);
  assert.doesNotMatch(header, /\n/);
  assert.equal(stripRoutineTriggerHeader(`${header}\n\nSummarize my day.`), 'Summarize my day.');
  assert.match(routineTriggerHeader({ kind: 'webhook', name: 'gh' }), /^\[Routine trigger\] Your webhook "gh" fired\./);
});
