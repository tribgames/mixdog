import assert from 'node:assert/strict';
import test from 'node:test';

import { ipcErrorEnvelope, ipcErrorFromEnvelope } from '../../shared/coded-error.ts';
import { coreErrorForWindow } from '../../shared/core-lanes/core-error.ts';
import { directError, withDirectErrors } from './errors.ts';

const rpc = (data) =>
  Object.assign(new Error(`-32600 ${data.reason} ${data.reason}`), {
    name: 'ClientError',
    detail: { kind: 'rpc', code: -32600, reason: data.reason, message: data.reason, data },
  });
const domain = (code, message, detail) => rpc({ reason: 'domainError', domain: 'x', code, message, ...(detail ? { detail } : {}) });

const samples = {
  invalidParams: rpc({ reason: 'invalidParams', expected: 'name must be a string' }),
  invalidParamsNoText: rpc({ reason: 'invalidParams' }),
  plain: rpc({ reason: 'domainError', domain: 'config', message: 'threshold must be between 10 and 95' }),
  worktreeBusy: domain('WORKTREE_BUSY_JOBS', 'Busy.', { type: 'worktree', reason: 'running', count: 2 }),
  worktreeBare: domain('WORKTREE_BRANCH_OCCUPIED', 'Occupied.'),
  room: domain('ROOM_MEMBER_SWITCHED_OFF', 'Member is switched off.', { type: 'roomMember', name: 'Bench', count: 1 }),
  roomNoName: domain('ROOM_MEMBER_SWITCHED_OFF', 'Member is switched off.', { type: 'roomMember', count: 1 }),
  scheduleTaken: domain('SCHEDULE_NAME_TAKEN', 'Taken.', { type: 'schedule', name: 'nightly', other: 'x' }),
  scheduleUncertain: domain('SCHEDULE_RENAME_UNCERTAIN', 'Unsure.', { type: 'schedule', name: 'nightly' }),
  scheduleLongName: domain('SCHEDULE_RENAME_RUNNING', 'Running.', { type: 'schedule', name: 'n'.repeat(201) }),
  file: domain('ENOENT', 'No such file.', { type: 'file', path: 'C:/secret/a.txt' }),
  fileGrant: domain('SELECTED_FILE_GRANT_UNAVAILABLE', 'Grant gone.'),
  noMessageCode: domain('PROJECT_UNAVAILABLE', undefined),
  permissionDenied: rpc({ reason: 'permissionDenied' }),
  methodNotFound: rpc({ reason: 'methodNotFound' }),
  connectionLost: Object.assign(new Error('lost'), { name: 'ClientError', detail: { kind: 'connectionLost' } }),
  opOutcomeUnknown: Object.assign(new Error('unknown'), { name: 'ClientError', detail: { kind: 'opOutcomeUnknown' } }),
  notAnError: 'boom',
};

const fields = (e) => (e instanceof Error ? { name: e.name, message: e.message, code: e.code, details: e.details } : e);

for (const [label, sample] of Object.entries(samples)) {
  test(`direct error equals the envelope path: ${label}`, () => {
    const shown = coreErrorForWindow(sample);
    const old = ipcErrorFromEnvelope(ipcErrorEnvelope(shown)) ?? shown;
    assert.deepEqual(fields(directError(sample)), fields(old));
  });
}

test('only public params survive and the trailer stays in the message', () => {
  const room = directError(samples.room);
  assert.deepEqual(room.details, { name: 'Bench' });
  assert.equal(room.code, 'ROOM_MEMBER_SWITCHED_OFF');
  assert.match(room.message, /^Member is switched off\.\n\[worktree-details\] \{"code":"ROOM_MEMBER_SWITCHED_OFF"/);
  assert.equal(directError(samples.file).details, undefined);
  assert.equal(directError(samples.scheduleLongName).details, undefined);
});

test('a worktree code keeps its details in the message and an invalid argument is the TypeError', () => {
  const busy = directError(samples.worktreeBusy);
  assert.equal(busy.code, 'WORKTREE_BUSY_JOBS');
  assert.match(busy.message, /\[worktree-details\]/);
  assert.equal(directError(samples.invalidParams) instanceof TypeError, true);
});

test('withDirectErrors maps a rejection and passes a value through', async () => {
  assert.equal(await withDirectErrors(Promise.resolve(7)), 7);
  await assert.rejects(withDirectErrors(Promise.reject(samples.scheduleTaken)), (e) => e.code === 'SCHEDULE_NAME_TAKEN' && e.details.name === 'nightly');
});
