// Worker-thread body for process-runner.mjs: helper children (process-table
// enumeration, tree kills) are spawned on this thread, never on the host
// event loop (run-child.mjs).
import { runChild } from './run-child.mjs';
import { serveWorkerRequests } from './worker-requests.mjs';

serveWorkerRequests(runChild);
