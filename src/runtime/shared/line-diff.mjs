// Line diffs from one shared worker thread so a large Myers diff never stalls
// the host event loop. Started on first use; an idle worker never keeps the
// process alive.
import { createWorkerRequestClient } from './worker-requests.mjs';

const requestLineDiff = createWorkerRequestClient(new URL('./line-diff-worker.mjs', import.meta.url));

/**
 * `structuredPatch(oldFileName, newFileName, oldText, newText, '', '',
 * { context, timeout })` computed off the main thread. Resolves to the
 * structured patch ({ oldFileName, newFileName, oldHeader, newHeader, hunks }),
 * or null when the diff took longer than `timeout` ms.
 */
export function structuredPatchOffThread(oldFileName, newFileName, oldText, newText, { context, timeout }) {
  return requestLineDiff({ oldFileName, newFileName, oldText, newText, context, timeout });
}
