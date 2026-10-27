// The admission thread (activity-gate.mjs): runs the ledger operations its
// starter posts, one at a time and in the order they were posted. A request it
// answers is complete — both copies written, or refused — and nothing here
// ever waits for the thread that posted it.
import { parentPort, workerData } from 'node:worker_threads';
import { LEDGER_SLOTS as SLOT, admit, hold, release } from './activity-ledger.mjs';

const slots = new Int32Array(workerData.slots);
const { syncPort } = workerData;
const operations = { admit, hold, release };

// Fault injection for tests only (MIXDOG_ADMISSION_TEST_FAULT_HOOK=1): the
// one fixed test-support module beside this file, loaded before the first
// request is taken. It is not shipped (package.json `files`), so in an
// installed runtime the flag does nothing.
if (workerData.faultHook) {
  try {
    await import(new URL('./activity-gate-faults.test-hook.mjs', import.meta.url).href);
  } catch (error) {
    if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error;
  }
}

process.on('exit', () => {
  Atomics.store(slots, SLOT.STOPPED, 1);
  Atomics.notify(slots, SLOT.ANSWERED);
  Atomics.notify(slots, SLOT.DONE);
});

const serialize = (error) => ({
  name: error?.name,
  message: String(error?.message ?? error),
  code: error?.code,
  details: error?.details,
});

parentPort.on('message', ({ id, op, args, sync }) => {
  let answer;
  try {
    answer = { id, value: operations[op](args) };
  } catch (error) {
    answer = { id, error: serialize(error) };
  }
  if (!sync) parentPort.postMessage(answer);
  else if (Atomics.compareExchange(slots, SLOT.SYNC, id, -id) === id) {
    syncPort.postMessage(answer);
    Atomics.add(slots, SLOT.ANSWERED, 1);
    Atomics.notify(slots, SLOT.ANSWERED);
  } else if (op !== 'release' && answer.value) {
    // Its caller stopped waiting and reported the outcome unknown: nobody
    // holds this grant, so it is withdrawn here.
    release(answer.value);
  }
  Atomics.add(slots, SLOT.DONE, 1);
  Atomics.notify(slots, SLOT.DONE);
});
