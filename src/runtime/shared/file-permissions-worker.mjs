// Worker side of file-permissions.mjs's sync bridge: owner-only enforcement
// for synchronous callers, through this thread's own long-lived ACL helper.
// Every request is answered on the port, then the shared counter (slot 0) is
// bumped and notified so the blocked caller wakes; slot 1 marks this thread
// gone, slot 2 marks it ready.
import { workerData } from 'node:worker_threads';
import {
  enforceOwnerOnlyAclWin32Async,
  prewarmOwnerOnlyAclWin32,
  shutdownOwnerOnlyAclHelper,
} from './file-permissions.mjs';

const { port, signal } = workerData;
let pending = 0;
let shuttingDown = false;

function wake() {
  Atomics.add(signal, 0, 1);
  Atomics.notify(signal, 0);
}

function maybeExit() {
  if (!shuttingDown || pending > 0) return;
  shutdownOwnerOnlyAclHelper();
  port.close();
}

process.on('exit', () => {
  shutdownOwnerOnlyAclHelper();
  Atomics.store(signal, 1, 1);
  wake();
});

port.on('message', async (request) => {
  if (request?.shutdown === true) {
    shuttingDown = true;
    maybeExit();
    return;
  }
  pending += 1;
  try {
    if (request?.warm === true) {
      await prewarmOwnerOnlyAclWin32({ bridge: false });
      return;
    }
    let reply;
    try {
      await enforceOwnerOnlyAclWin32Async(request.path, { fresh: true });
      reply = { id: request.id, ok: true };
    } catch (error) {
      reply = { id: request.id, ok: false, message: String(error?.message || error), code: error?.code ?? null };
    }
    port.postMessage(reply);
    wake();
  } finally {
    pending -= 1;
    maybeExit();
  }
});

Atomics.store(signal, 2, 1);
wake();
