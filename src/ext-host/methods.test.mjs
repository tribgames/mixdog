// The worker's end waits for its Microsoft Office session hosts: the core ends the worker's job, the hosts with it, the
// moment the worker exits, and the application a host owns would outlive the job.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { sessionClients } from '../runtime/office/com/office-session-client.mjs';
import { closeOfficeSessions } from './methods.mjs';

test('closeOfficeSessions gives every session host its EOF and resolves once each has closed', async () => {
  const order = [];
  for (const sessionId of ['word', 'excel']) {
    const child = new EventEmitter();
    child.exitCode = null;
    child.ref = () => {};
    child.unref = () => {};
    let ended = false;
    child.stdin = {
      end: () => {
        if (ended) return;
        ended = true;
        order.push(`eof ${sessionId}`);
        setTimeout(() => {
          order.push(`closed ${sessionId}`);
          child.exitCode = 0;
          child.emit('close', 0);
        }, 20);
      },
    };
    sessionClients.set(sessionId, { sessionId, child, pending: new Map(), stderr: '', readline: { close() {} } });
  }
  await closeOfficeSessions();
  order.push('resolved');
  assert.deepEqual(order.slice(0, 2).sort(), ['eof excel', 'eof word']);
  assert.deepEqual(order.slice(2, 4).sort(), ['closed excel', 'closed word']);
  assert.equal(order[4], 'resolved', 'the end waits for both hosts');
  assert.equal(sessionClients.size, 0, 'each closed host is released');
});
