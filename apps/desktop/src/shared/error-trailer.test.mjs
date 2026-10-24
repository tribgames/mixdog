import assert from 'node:assert/strict';
import test from 'node:test';

import {
  displayErrorMessage,
  errorParams,
  ipcErrorEnvelope,
  ipcErrorFromEnvelope,
  withoutErrorTrailer,
} from './coded-error.ts';
import { ERROR_TRAILER_MARKER, appendErrorTrailer, splitErrorTrailer } from './error-trailer.ts';
import { roomErrorCode, roomMemberSwitchedOffError } from './room-error-codes.ts';
import { scheduleErrorCode } from './schedule-error-codes.ts';

/** What the page holds after `contextBridge`: the message only. */
const bridged = (error) => new Error(error.message);
const MARKER = '\n[worktree-details] ';

const taken = () =>
  Object.assign(new Error('A schedule named "b" already exists.'), {
    code: 'SCHEDULE_NAME_TAKEN',
    details: { name: 'b' },
  });
const carried = (error) => bridged(ipcErrorFromEnvelope(structuredClone(ipcErrorEnvelope(error))));

test('the trailer keeps the worktree wire format', () => {
  assert.equal(ERROR_TRAILER_MARKER, MARKER);
  assert.equal(appendErrorTrailer('m', { a: 1 }), 'm\n[worktree-details] {"a":1}');
  assert.equal(appendErrorTrailer(`m${MARKER}{}`, { a: 1 }), `m${MARKER}{}`, 'never a second trailer');
  assert.equal(appendErrorTrailer('m', { a: 'x'.repeat(10) }, 5), 'm', 'too long: left off');
  assert.deepEqual(splitErrorTrailer('m\n[worktree-details] {"a":1}'), { message: 'm', payload: { a: 1 } });
  assert.deepEqual(splitErrorTrailer(`m${MARKER}{broken`), { message: 'm', payload: null });
  assert.equal(splitErrorTrailer('m'), null);
});

test('a schedule and a room refusal carry code and params across the bridge, and read back clean', () => {
  const schedule = carried(taken());
  assert.equal(scheduleErrorCode(schedule), 'SCHEDULE_NAME_TAKEN');
  assert.deepEqual(errorParams(schedule), { name: 'b' });
  assert.equal(displayErrorMessage(schedule), 'A schedule named "b" already exists.');
  assert.equal(withoutErrorTrailer(schedule).message, 'A schedule named "b" already exists.');
  assert.equal(withoutErrorTrailer(schedule).code, 'SCHEDULE_NAME_TAKEN');
  const room = carried(roomMemberSwitchedOffError('Bench'));
  assert.equal(roomErrorCode(room), 'ROOM_MEMBER_SWITCHED_OFF');
  assert.deepEqual(errorParams(room), { name: 'Bench' });
  assert.equal(displayErrorMessage(room), '"Bench" is switched off.');
  assert.equal(scheduleErrorCode(room), undefined, 'a room code is not a schedule code');
});

test('an error with no translated code gets no trailer', () => {
  const plain = ipcErrorFromEnvelope(
    structuredClone(ipcErrorEnvelope(Object.assign(new Error('gone'), { code: 'ENOENT' })))
  );
  assert.equal(plain.message, 'gone');
});

test('only a supported code with object params is consumed; anything else is left as it is', () => {
  const cases = [
    ['malformed JSON', `x${MARKER}{"code":"SCHEDULE_NAME_TAKEN","params":`],
    ['unknown code', `x${MARKER}{"code":"SOMETHING_ELSE","params":{"name":"b"}}`],
    ['a worktree trailer', `x${MARKER}{"estimateBytes":5}`],
    ['a non-string code', `x${MARKER}{"code":5}`],
    ['array params', `x${MARKER}{"code":"SCHEDULE_NAME_TAKEN","params":["b"]}`],
    ['null params', `x${MARKER}{"code":"SCHEDULE_NAME_TAKEN","params":null}`],
    ['a non-object payload', `x${MARKER}"SCHEDULE_NAME_TAKEN"`],
    ['a coincidental suffix', 'x [worktree-details] {"code":"SCHEDULE_NAME_TAKEN"}'],
  ];
  for (const [label, message] of cases) {
    const error = new Error(message);
    assert.equal(scheduleErrorCode(error), undefined, label);
    assert.equal(errorParams(error), undefined, label);
    assert.equal(displayErrorMessage(error), message, `${label}: message untouched`);
    assert.equal(withoutErrorTrailer(error), error, `${label}: same error`);
  }
});

test('a refusal whose own text holds the marker still carries its code and keeps that text', () => {
  const text = `A schedule named "b${MARKER}c" already exists.`;
  const error = carried(
    Object.assign(new Error(text), { code: 'SCHEDULE_NAME_TAKEN', details: { name: `b${MARKER}c` } })
  );
  assert.equal(scheduleErrorCode(error), 'SCHEDULE_NAME_TAKEN');
  assert.deepEqual(errorParams(error), { name: `b${MARKER}c` });
  assert.equal(displayErrorMessage(error), text);
});

test('a valid trailer without params carries its code alone', () => {
  const error = new Error(`unsure${MARKER}{"code":"SCHEDULE_RENAME_UNCERTAIN"}`);
  assert.equal(scheduleErrorCode(error), 'SCHEDULE_RENAME_UNCERTAIN');
  assert.equal(displayErrorMessage(error), 'unsure');
});
