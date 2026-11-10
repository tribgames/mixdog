// Records what Node's transcript restore (src/runtime/agent/orchestrator/session/transcript-restore/restore.mjs) makes of a
// stored completed session, for apps/desktop/src/main/session-final-answer.test.mjs: the desktop's sessionFinalAnswer reads
// those rows, and the restore itself went with the Node core. Inputs are the ones that test of NODE_COMMIT used.
//
//   node apps/desktop/src/shared/test-recorded/record/record-session-final-answer.mjs
import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { recorderProvenance } from '../../../../../../benchmarks/rust-core/recorders/lib/provenance.mjs';
import { exportNodeTree } from '../../../../../../src/tui/components/status-line/footer-golden/node-tree.mjs';
import { NODE_COMMIT } from './node-source.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../../../../..');
const { tree, commit } = exportNodeTree(repo);
if (commit !== NODE_COMMIT) throw new Error(`the Node export is ${commit}, the recordings are pinned to ${NODE_COMMIT}`);
const MODULE = 'src/runtime/agent/orchestrator/session/transcript-restore/restore.mjs';
const { restoreTranscriptItems } = await import(pathToFileURL(join(tree, MODULE)).href);

const stored = (status) => [
  { role: 'user', content: 'Check this' },
  { role: 'assistant', content: 'Progress, not the final reply' },
  {
    role: 'assistant',
    content: 'Background answer',
    meta: { transcript: { at: 2_000, completion: { status, elapsedMs: 1_000 } } },
  },
];
// `itemLimit: Infinity` is the test's first call; JSON has no Infinity, so the case names the limit instead.
const cases = [
  { name: 'done, every item', messages: stored('done'), options: { sessionId: 'stored', itemLimit: Infinity } },
  { name: 'done, last 2 items', messages: stored('done'), options: { sessionId: 'stored', itemLimit: 2 } },
  { name: 'failed, no options', messages: stored('failed'), options: undefined },
];
const recording = {
  source: { commit, module: MODULE, test: 'apps/desktop/src/main/session-final-answer.test.mjs', ...recorderProvenance(import.meta.url) },
  cases: cases.map(({ name, messages, options }) => ({
    name,
    messages,
    options: options && { ...options, itemLimit: String(options.itemLimit) },
    items: restoreTranscriptItems(structuredClone(messages), options),
  })),
};
writeFileSync(resolve(here, '../session-final-answer.restore.node.json'), `${JSON.stringify(recording, null, 1)}\n`);
