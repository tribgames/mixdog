// The Stop scenarios both abort recordings (Node's real daemon behind its SessionHost; a running mixdogd) are driven through, one fresh thread
// each. `prompt` is the first prompt (its HOLD marker picks the provider's answer: remote-protocol-chat-abort-provider.mjs), `output` waits
// for the streamed text to reach the client before the Stop, `then` is a second prompt sent while the first still runs (a queued
// steering prompt), `pasted` rides the first prompt, `stop` is what the phone sends, and `again` stops a second time once the first Stop settled.
// `submitter` / `canceller` name the paired devices that send the prompt and the Stop (the same one unless a case says otherwise), `submit` adds options to
// the prompt's submission, and `ready` is the state the turn is in when the Stop comes: `held` (the endpoint holds the request; the default), `approval`
// (a tool call waits for the person's approval) or `completed` (the turn ended on its own). `requeued` marks a Stop after which the prompt is queued again (a runtime's turn is never handed back) and
// runs a second turn, which the case waits for.
//
// A case with `notify` answers the pending approval from a notification (`answerApprovalNotification`) once per entry, in order: `action`
// allow or deny, `id` 'shown' (the approval the phone's state showed at its first answer) or any other string (an approval the session does not show); a case
// without `stop` sends no Stop and waits for its turn to end on its own. `ready: 'ask'` is a read a hook rule asks the person about (HOOK_RULES).
import { ASKED_FILE, FINAL, PARTIAL } from './remote-protocol-chat-abort-provider.mjs';

/** The files the tool-call cases' reads find, written in each project folder before the cases run. */
export const PROJECT_FILE = { name: 'package.json', text: '{"name":"abort-project"}\n' };
export const ASKED_PROJECT_FILE = { name: ASKED_FILE, text: '{"asked":true}\n' };
/** The legacy hook rule file (`<data dir>/hooks.json`, hook-bus/config.mjs hookRulesPath; the core's hook_bus/config.rs): a read of
 *  ASKED_FILE asks the person first (rules.mjs decisionFromRule 'ask'), every other call runs as before. */
export const HOOK_RULES = [{ tool: 'read', match: ASKED_FILE, action: 'ask' }];
export const PASTED = { 1: { id: 1, text: 'a pasted block' } };
export const DEVICES = { a: 'Phone A', b: 'Phone B' };
export const ABORT_CASES = [
  { name: 'running-no-output', prompt: 'HOLD-EMPTY write the file', stop: {} },
  { name: 'running-with-output', prompt: 'HOLD-TEXT write the file', output: PARTIAL, stop: {} },
  { name: 'running-keep-prompt', prompt: 'HOLD-EMPTY keep this prompt', stop: { restorePrompt: false } },
  { name: 'running-steering-queued', prompt: 'HOLD-EMPTY first prompt', then: 'and also this', stop: {} },
  { name: 'running-pasted-text', prompt: 'HOLD-EMPTY with a paste', pasted: PASTED, stop: {} },
  { name: 'running-after-tool-call', prompt: 'HOLD-TOOL read the file', stop: {} },
  { name: 'running-then-stopped-again', prompt: 'HOLD-EMPTY stop me twice', stop: {}, again: {} },
  { name: 'other-device-plain-text', prompt: 'HOLD-EMPTY sent from the first phone', canceller: DEVICES.b, stop: {} },
  { name: 'other-device-with-attachment', prompt: 'HOLD-EMPTY with a paste from the first phone', pasted: PASTED, canceller: DEVICES.b, stop: {} },
  { name: 'running-approval-pending', prompt: 'HOLD-APPROVAL add a file', ready: 'approval', stop: {} },
  { name: 'running-ask-pending', prompt: 'HOLD-ASK read the asked file then stop', ready: 'ask', stop: {} },
  { name: 'running-runtime-turn', prompt: 'HOLD-EMPTY greet the user', submit: { kickoff: true }, stop: {}, requeued: true },
  { name: 'running-answer-streamed-turn-open', prompt: 'HOLD-FINAL answer', output: FINAL, stop: {} },
  { name: 'idle-after-completed-turn', prompt: 'a plain question', ready: 'completed', stop: {} },
  { name: 'notify-allow-answered', prompt: 'HOLD-ASK read the asked file', ready: 'ask', notify: [{ action: 'allow', id: 'shown' }] },
  { name: 'notify-deny-answered', prompt: 'HOLD-ASK read the denied file', ready: 'ask', notify: [{ action: 'deny', id: 'shown' }] },
  { name: 'notify-deny-settled', prompt: 'HOLD-ASK read the file twice answered', ready: 'ask', notify: [{ action: 'allow', id: 'shown' }, { action: 'deny', id: 'shown' }] },
  { name: 'notify-allow-unknown-id', prompt: 'HOLD-ASK read the file of another approval', ready: 'ask', notify: [{ action: 'allow', id: 'not-the-shown-approval' }, { action: 'deny', id: 'not-the-shown-approval' }, { action: 'allow', id: 'shown' }] },
  { name: 'notify-allow-question', prompt: 'HOLD-APPROVAL ask about the file', ready: 'approval', notify: [{ action: 'allow', id: 'shown' }], stop: {} },
];
