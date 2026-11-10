// The Stop scenarios both abort recordings (Node's real daemon behind its SessionHost; a running mixdogd) are driven through, one fresh thread
// each. `prompt` is the first prompt (its HOLD marker picks the provider's answer: remote-protocol-chat-abort-provider.mjs), `output` waits
// for the streamed text to reach the client before the Stop, `then` is a second prompt sent while the first still runs (a queued
// steering prompt), `pasted` rides the first prompt, `stop` is what the phone sends, and `again` stops a second time once the first Stop settled.
import { PARTIAL } from './remote-protocol-chat-abort-provider.mjs';

export const PASTED = { 1: { id: 1, text: 'a pasted block' } };
export const ABORT_CASES = [
  { name: 'running-no-output', prompt: 'HOLD-EMPTY write the file', stop: {} },
  { name: 'running-with-output', prompt: 'HOLD-TEXT write the file', output: PARTIAL, stop: {} },
  { name: 'running-keep-prompt', prompt: 'HOLD-EMPTY keep this prompt', stop: { restorePrompt: false } },
  { name: 'running-steering-queued', prompt: 'HOLD-EMPTY first prompt', then: 'and also this', stop: {} },
  { name: 'running-pasted-text', prompt: 'HOLD-EMPTY with a paste', pasted: PASTED, stop: {} },
  { name: 'running-then-stopped-again', prompt: 'HOLD-EMPTY stop me twice', stop: {}, again: {} },
];
