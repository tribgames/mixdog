// The Stop scenarios both abort recordings (Node's real daemon behind its SessionHost; a running mixdogd) are driven through, one fresh thread
// each. `prompt` is the first prompt (its HOLD marker picks the provider's answer: remote-protocol-chat-abort-provider.mjs), `output` waits
// for the streamed text to reach the client before the Stop, `then` is a second prompt sent while the first still runs (a queued
// steering prompt), `pasted` rides the first prompt, `stop` is what the phone sends, and `again` stops a second time once the first Stop settled.
// `submitter` / `canceller` name the paired devices that send the prompt and the Stop (the same one unless a case says otherwise), `submit` adds options to
// the prompt's submission, and `ready` is the state the turn is in when the Stop comes: `held` (the endpoint holds the request; the default), `approval`
// (a tool call waits for the person's approval) or `completed` (the turn ended on its own). `requeued` marks a Stop after which the prompt is queued again (a runtime's turn is never handed back) and
// runs a second turn, which the case waits for.
import { FINAL, PARTIAL } from './remote-protocol-chat-abort-provider.mjs';

/** The file the tool-call case's read finds, written in each project folder before the cases run. */
export const PROJECT_FILE = { name: 'package.json', text: '{"name":"abort-project"}\n' };
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
  { name: 'running-runtime-turn', prompt: 'HOLD-EMPTY greet the user', submit: { kickoff: true }, stop: {}, requeued: true },
  { name: 'running-answer-streamed-turn-open', prompt: 'HOLD-FINAL answer', output: FINAL, stop: {} },
  { name: 'idle-after-completed-turn', prompt: 'a plain question', ready: 'completed', stop: {} },
];
