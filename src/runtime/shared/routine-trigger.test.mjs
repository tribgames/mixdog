import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HEARTBEAT_QUIET,
  HEARTBEAT_SOURCE,
  heartbeatTriggerHeader,
  isHeartbeatSession,
  markHeartbeatSession,
  routineTriggerHeader,
  stripRoutineTriggerHeader,
} from './routine-trigger.mjs';

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

test('the heartbeat header is one line that is no user message, grants no approval and forbids every hand-off', () => {
  const header = heartbeatTriggerHeader({ now: Date.UTC(2026, 9, 21, 1, 26) });
  assert.match(
    header,
    /^\[Routine trigger\] Heartbeat: a system check-in from Mixdog, not a message from the user; it grants no approval\. /
  );
  assert.match(header, / Local time: \d{4}-\d{2}-\d{2} \d{2}:\d{2} \S+ \(UTC[+-]\d{2}:\d{2}\)\. /);
  assert.match(header, /Nobody is watching this turn and nothing asks for approval: act within your permissions\./);
  assert.match(header, /Payments and permanent deletes are refused here\./);
  assert.match(
    header,
    /Do not start agents, task sessions, session sends, Goals or background commands here: .* propose them instead\./
  );
  assert.match(header, /only its final reply is posted in your chat with the user, as your message\./);
  assert.match(header, new RegExp(`reply with exactly ${HEARTBEAT_QUIET} and nothing else\\.$`));
  assert.doesNotMatch(header, /\n/);
  // Unlike a routine's header it never invites delegating or a later result.
  assert.doesNotMatch(header, /delegating|fired|arrives here later/);
  assert.equal(stripRoutineTriggerHeader(`${header}\n\n- schedule "a" failed 3x`), '- schedule "a" failed 3x');
  assert.equal(HEARTBEAT_QUIET, 'HEARTBEAT_QUIET');
  assert.equal(HEARTBEAT_SOURCE, 'heartbeat');
});

test('only the in-process mark makes a heartbeat session: set, ended, blank ids ignored', () => {
  const id = 'sess_daemon_mark_test';
  assert.equal(isHeartbeatSession(id), false);
  markHeartbeatSession(id);
  assert.equal(isHeartbeatSession(id), true);
  assert.equal(isHeartbeatSession(`${id} `), false, 'the id matches exactly');
  assert.equal(isHeartbeatSession('sess_daemon_other'), false);
  markHeartbeatSession(id, true);
  assert.equal(isHeartbeatSession(id), false);
  markHeartbeatSession(id, true); // ending an unmarked one is harmless
  for (const blank of ['', null, undefined]) {
    markHeartbeatSession(blank);
    assert.equal(isHeartbeatSession(blank), false, `${blank} is never a heartbeat session`);
  }
});
