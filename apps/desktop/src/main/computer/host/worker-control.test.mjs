import assert from 'node:assert/strict';
import test from 'node:test';
import { createSequenceHoldRelease, killSessionWorkers, retireBridgeWorkers } from './worker-control.ts';

const worker = (killed = false, kill = () => {}) => ({ killed, kill });

test('sequence holds are released only through a live worker, and a refusal is the runner error', async () => {
  const requests = [];
  let reply = { id: 1, ok: true };
  const release = createSequenceHoldRelease({
    powerShellBySession: new Map([
      ['live', worker()],
      ['dead', worker(true)],
    ]),
    callPowerShell: async (request) => {
      requests.push(request);
      return reply;
    },
  });
  await release('missing');
  await release('dead');
  assert.deepEqual(requests, []);
  await release('live');
  assert.deepEqual(requests, [{ action: 'release_sequence_holds', session_id: 'live', read_only: false }]);
  reply = { id: 2, ok: false, error: 'busy' };
  await assert.rejects(release('live'), /^Error: input_cleanup_unconfirmed: sequence holds were not released: busy$/);
});

test('a stopped bridge retires each worker once, however many sessions share it', () => {
  const shared = worker();
  const alone = worker();
  const retired = [];
  retireBridgeWorkers(
    new Map([
      ['a', shared],
      ['b', shared],
      ['c', alone],
    ]),
    (child, error) => retired.push([child, error.message])
  );
  assert.deepEqual(retired, [
    [shared, 'computer bridge stopped'],
    [alone, 'computer bridge stopped'],
  ]);
});

test('dispose kills every live worker, tolerates one already gone, and empties the table', () => {
  const kills = [];
  const workers = new Map([
    ['live', worker(false, () => kills.push('live'))],
    ['dead', worker(true, () => kills.push('dead'))],
    [
      'gone',
      worker(false, () => {
        throw new Error('ESRCH');
      }),
    ],
    ['last', worker(false, () => kills.push('last'))],
  ]);
  killSessionWorkers(workers);
  assert.deepEqual(kills, ['live', 'last']);
  assert.equal(workers.size, 0);
});
