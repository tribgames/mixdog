// Worker-thread body for line-diff.mjs. A Myers line diff of large rewrites
// runs for seconds of pure CPU, so it is computed here instead of on the host
// event loop. Each request resolves to the structuredPatch result, or null
// when the diff exceeded its `timeout`.
import { structuredPatch } from 'diff';
import { serveWorkerRequests } from './worker-requests.mjs';

serveWorkerRequests(
  ({ oldFileName, newFileName, oldText, newText, context, timeout }) =>
    structuredPatch(oldFileName, newFileName, oldText, newText, '', '', { context, timeout }) ?? null
);
