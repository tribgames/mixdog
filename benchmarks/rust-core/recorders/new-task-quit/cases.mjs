// The cases of the app's quit while a new task is in flight (record-new-task-quit.mjs records them on Node, replay.mjs replays them on the core):
// one request, held inside a call of its draft step where that call waits on something outside the daemon, the app quits, the app starts
// again and the same request comes in again. And the draft's workflow and orchestration mode, applied and not found.
//
// A step of the draft is held where Node's daemon waits outside itself, through a seam the product has:
//   setRoute         the custom provider's reachability probe (`HEAD /` on its base URL), sent while `setRoute` readies the provider (the
//                    probe and the model list are sent between `setOrchestrationMode`'s and `setRoute`'s lines of daemon.log)
//   requestWorktree  its first git command (`rev-parse --is-bare-repository`, git.mjs:144) through the `git` first on the daemon's PATH
// Not held, with the reason:
//   create                 `client.create` (session-views.mjs:30-64) waits on nothing outside the daemon: no git, provider or file the
//                          recorder could hold is touched before `session created` is logged
//   setWorkflow            `loadWorkflowPack` reads WORKFLOW.md synchronously (workflow-packs.mjs:59-63, packs.mjs:37-46, 93-96) and the
//                          switch is in memory; the config write is queued, not awaited (config-writers.mjs:168)
//   setOrchestrationMode   validated and switched in memory (style-and-mode.mjs:46-52, session-switches.mjs:148)
// A quit at those calls is the kill at that point (Node's call outstanding at `process.exit`, daemon.mjs:412): the new-task-dedupe
// set's `crash` scenarios.
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { stableStringify } from '../lib/common.mjs';

const ROOT = 'D:\\mixdog-build\\tmp\\new-task-quit\\cases';
/** A case's folder, the same for both recordings and the replay: the project path is part of the request. */
export const caseRoot = (c) => join(ROOT, c.name);

const route = { provider: 'custom-harness', model: 'harness-model' };
const prompt = 'write the quarterly report';
const options = { displayText: prompt };
export const CONTENTS = {
  route: { prompt, options, draft: { route } },
  worktree: { prompt, options, draft: { route, worktree: {} } },
  settings: { prompt, options, draft: { workflowId: 'headless', orchestrationMode: 'focused', route } },
  'missing-workflow': { prompt, options, draft: { workflowId: 'gone', orchestrationMode: 'balanced', route } },
};

export const CASES = [
  { name: 'quit-in-set-route', id: 's-quit-route', content: CONTENTS.route, hold: { step: 'setRoute', provider: 'HEAD /' } },
  { name: 'quit-in-request-worktree', id: 's-quit-worktree', content: CONTENTS.worktree, hold: { step: 'requestWorktree', git: '-c core.longpaths=true rev-parse --is-bare-repository' } },
  { name: 'draft-settings', id: 's-settings', content: CONTENTS.settings, hold: null },
  { name: 'draft-missing-workflow', id: 's-missing-workflow', content: CONTENTS['missing-workflow'], hold: null },
];

const derived = (id) => `sess_desktop_${createHash('sha256').update(id).digest('hex')}`;
const FRESH = /sess_desktop_[0-9a-f]{64}/g;
/** The case's addresses, the derived one kept and every other numbered by first appearance (keys in sorted order): `<fresh:1>`, … */
export function numberFresh(c, value) {
  const keep = derived(c.id);
  const seen = [];
  const numbered = JSON.parse(stableStringify(value, 0).replace(FRESH, (address) => {
    if (address === keep) return address;
    if (!seen.includes(address)) seen.push(address);
    return `<fresh:${seen.indexOf(address) + 1}>`;
  }));
  // `stored` is a set of ids: in sorted order once numbered (by raw id, its order would follow the random addresses).
  for (const step of Array.isArray(numbered) ? numbered : []) if (Array.isArray(step?.stored)) step.stored.sort();
  return numbered;
}

export const COMPARISON = {
  method: 'each case whole: every recorded step, the core side built as `translated` states',
  notRecorded: {
    'recorded[].reply.snapshot':
      "the session snapshot Node's answer carries (session-host-lifecycle.ts:922,951); its workflow and orchestration mode are recorded as `settings`. The core's answer carries no snapshot (its session state travels on the subscription's feed)",
  },
  translated: {
    'recorded[0].reply (a held case)':
      "the interrupted request's answer: Node's is the app's own client's rejection of its pending call when the quit disposes it (desktop-service-client.ts:1065-1080 `rejectPending`, `Mixdog desktop service client is disposed.`); no daemon answers it. Both sides are `{ok: false, unanswered: true}` when no answer reached the caller before its connection closed (the core's answer after that is the protocol client's own rejection)",
    'recorded[].reply': "an answer through the desktop's service lane (service-route.ts: `thread/start`), the core's translated as the new-task-dedupe replay's (`thread.id` is `sessionId`, `accepted: true`, less its `coreNotCompared` paths); a rejection is its message and every own field of the error",
    'recorded[].listed': "the ids the app lists while the attempt is held: Node's `listSessions` (host), the core's `thread/list`",
    'recorded[].stop': "Node's `stopInTreeDaemon` outcome `{stopped, request}`; the core's is its exit after `mixdogd ctl stop --when-idle --reason userStop` (the stop request that does not wait for a new task, as Node's `/stop {force:true}`), the replay failing when it does not exit",
    'recorded[].stored': "the sessions stored after the step, by id: Node's `<data>/sessions/<id>.log.jsonl`, the core's `<data>/sessions/<id>` that `thread/items/list` reads",
    'recorded[].settings': "the workflow and orchestration mode of the accepted task: Node's from the answer's snapshot (`workflow`, `orchestrationMode`), the core's from the thread's `thread/workflow/updated` section after its first turn",
    'recorded[].receipts': 'the files of `<userdata>/new-task-receipts`, by name, byte for byte (latin1)',
  },
  normalised: {
    'fresh session address': 'numbered `<fresh:N>` by first appearance in the case on both sides',
    'recorded[].stored': 'a set of ids, sorted once the addresses are numbered (sorted by raw id its order would follow the random addresses)',
    'key order': 'objects without regard to key order; arrays in order',
  },
};
