import assert from 'node:assert/strict';
import test from 'node:test';

import { setCoreHumanOnlyHolds, withHumanOnlyApproval } from '../human-only-approval';
import { registerHumanOnlyHolds } from './human-only';

/** A host connection that answers `host/humanOnly/begin` with a new core id each time and records every request. */
function fakeConnection() {
  const requests = [];
  const closers = [];
  let next = 0;
  let failBegin = false;
  return {
    requests,
    closers,
    failBegin: (value) => {
      failBegin = value;
    },
    close: () => closers.forEach((close) => close()),
    request: async (method, params) => {
      requests.push([method, params]);
      if (method === 'host/humanOnly/begin') {
        if (failBegin) throw new Error('core connection closed');
        return { holdId: `core-${++next}` };
      }
      return {};
    },
    onClose: (listener) => closers.push(listener),
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('begin reaches the core before the dialog waits for the local lock, and end follows the dialog', async () => {
  const connection = fakeConnection();
  registerHumanOnlyHolds(connection);
  try {
    let release;
    const first = withHumanOnlyApproval(() => new Promise((resolve) => (release = resolve)), undefined, 'first');
    await settle();
    // A second dialog queues behind the first yet already holds the core.
    const second = withHumanOnlyApproval(async () => 'second', undefined, 'second');
    await settle();
    assert.deepEqual(
      connection.requests.map(([method, params]) => [method, params.label]),
      [
        ['host/humanOnly/begin', 'first'],
        ['host/humanOnly/begin', 'second'],
      ]
    );
    release('first');
    assert.equal(await first, 'first');
    assert.equal(await second, 'second');
    await settle();
    assert.deepEqual(
      connection.requests.slice(2).map(([method, params]) => [method, params.holdId]),
      [
        ['host/humanOnly/end', 'core-1'],
        ['host/humanOnly/end', 'core-2'],
      ]
    );
  } finally {
    setCoreHumanOnlyHolds(null);
  }
});

test('a reconnect declares an open dialog hold again, once, and the dialog ends the new hold', async () => {
  const connection = fakeConnection();
  const holds = registerHumanOnlyHolds(connection);
  try {
    let release;
    const dialog = withHumanOnlyApproval(() => new Promise((resolve) => (release = resolve)), undefined, 'the card');
    await settle();
    assert.equal(connection.requests.length, 1);

    // Still on its connection: nothing to declare.
    holds.redeclare();
    await settle();
    assert.equal(connection.requests.length, 1);

    // The connection closed: the core ended the hold; the next claim declares it again, not twice.
    connection.close();
    holds.redeclare();
    holds.redeclare();
    await settle();
    assert.deepEqual(
      connection.requests.map(([method, params]) => [method, params.label]),
      [
        ['host/humanOnly/begin', 'the card'],
        ['host/humanOnly/begin', 'the card'],
      ]
    );

    release('done');
    await dialog;
    await settle();
    assert.deepEqual(connection.requests[2], ['host/humanOnly/end', { holdId: 'core-2' }]);
  } finally {
    setCoreHumanOnlyHolds(null);
  }
});

test('a dialog closed while its hold is lost ends nothing, and a refused re-declaration is tried again at the next claim', async () => {
  const connection = fakeConnection();
  const holds = registerHumanOnlyHolds(connection);
  try {
    let release;
    const dialog = withHumanOnlyApproval(() => new Promise((resolve) => (release = resolve)), undefined, 'x');
    await settle();
    connection.close();
    connection.failBegin(true);
    holds.redeclare();
    await settle();
    connection.failBegin(false);
    holds.redeclare();
    await settle();
    assert.equal(connection.requests.filter(([method]) => method === 'host/humanOnly/begin').length, 3);
    release();
    await dialog;
    await settle();
    assert.deepEqual(connection.requests.at(-1), ['host/humanOnly/end', { holdId: 'core-2' }]);

    // Closed after the connection dropped and before any re-declaration: no end is sent.
    const lost = withHumanOnlyApproval(async () => 'ok', undefined, 'y');
    await settle();
    const before = connection.requests.length;
    connection.close();
    await lost;
    await settle();
    assert.equal(connection.requests.length, before);
  } finally {
    setCoreHumanOnlyHolds(null);
  }
});
