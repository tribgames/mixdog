// Records the guidance literals of Node's shell/task tool modules that the transcript filter must hide
// (apps/desktop/src/renderer/transcript-tool-row-pairs.test.mjs). The literals are private to runtime modules the
// K1 cut deleted, so they are lifted once from NODE_COMMIT's own sources (read with `git show`, never a working tree).
//
//   node apps/desktop/src/shared/test-recorded/record/record-runtime-guidance.mjs
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { NODE_COMMIT, NODE_TREE } from './node-source.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../../../../..');
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', maxBuffer: 1 << 28, windowsHide: true });
if (git('rev-parse', `${NODE_COMMIT}^{tree}`).trim() !== NODE_TREE) throw new Error(`${NODE_COMMIT} is not tree ${NODE_TREE}`);
const FILES = {
  promotion: 'src/runtime/agent/orchestrator/tools/lib/shell-run-background/promotion-results.mjs',
  backgrounded: 'src/runtime/agent/orchestrator/tools/builtin/bash-tool/backgrounded-result.mjs',
  shell: 'src/runtime/agent/orchestrator/tools/shell-command.mjs',
  taskTool: 'src/runtime/agent/orchestrator/tools/builtin/task-tool.mjs',
  backgroundTasks: 'src/runtime/shared/background-tasks.mjs',
};
const source = Object.fromEntries(Object.entries(FILES).map(([key, path]) => [key, git('show', `${NODE_COMMIT}:${path}`).replace(/\r\n/g, '\n')]));
const literal = (text, pattern) => {
  const match = pattern.exec(text);
  if (!match) throw new Error(`${NODE_COMMIT} source does not match ${pattern}`);
  return match;
};

const { promotion, taskTool } = source;
const notified = literal(
  taskTool,
  /`\\n\\n(Wait ended because a notification arrived)\$\{from\}(; it is delivered to you now\. This task \()\$\{taskId\}(\)[^`]+)`/
);
const again = literal(taskTool, /`\\n\\n(Wait ceiling reached again \()\$\{hits\}( times\)[^`]+)`/);
const notifiedHold = literal(promotion, /`(moved to background after) \$\{secs\}(s because a notification arrived[^`]+)`/);
const recording = {
  source: { commit: NODE_COMMIT, tree: NODE_TREE, modules: Object.values(FILES), command: 'node apps/desktop/src/shared/test-recorded/record/record-runtime-guidance.mjs' },
  guidance: literal(promotion, /const BACKGROUND_GUIDANCE =\s*'([^']+)'/)[1],
  // The three promotion lines with their seconds filled in, as the producer writes them.
  promotedHold: literal(promotion, /`moved to background after the \$\{secs\}s hold`/) && 'moved to background after the 60s hold',
  promotedTimeout: `${literal(promotion, /`(moved to background at timeout after) \$\{secs\}s`/)[1]} 120s`,
  promotedInput: `${literal(promotion, /`(moved to background on new user input after) \$\{secs\}s`/)[1]} 3s`,
  started: literal(promotion, /'(started in the background)'/)[1],
  noJob: literal(promotion, /: `\$\{verb\}(; still running — [^`]+)`/)[1],
  fallback: literal(source.backgrounded, /DEFAULT_BACKGROUND_MESSAGE =\s*'([^']+)'/)[1],
  queuedTail: literal(source.shell, /that starts when an execution slot frees\. ` \+\s*'([^']+)'/)[1],
  waitCues: [/'\\n\\n(Wait ended by new user input[^']+)'/, /'\\n\\n(Wait ceiling reached;[^']+)'/].map((p) => literal(taskTool, p)[1]),
  notified: [notified[1], notified[2], notified[3]],
  notifiedTaskIdSuffix: /` \(task_id: \$\{notifiedTaskId\}\)`/.test(taskTool),
  again: [again[1], again[2]],
  notifiedHold: [notifiedHold[1], notifiedHold[2]],
  placeholder: literal(source.backgroundTasks, /lines\.push\('', '(\(no result body[^']+)'\)/)[1],
};
writeFileSync(resolve(here, '../transcript-tool-row-pairs.guidance.node.json'), `${JSON.stringify(recording, null, 1)}\n`);
