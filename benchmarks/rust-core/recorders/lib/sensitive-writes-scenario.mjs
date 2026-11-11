// The scenario of record-sensitive-writes.mjs (Node) and replay-sensitive-writes.mjs (the core): one conversation whose first
// turn mentions the mailed code before anything marks it (that turn is stored in the session and in the memory database's
// search rows with the code in plain text, so the mark must replace and scrub them), then the agent fills a mailed code with `sensitive: true` (it succeeds), fills a second sensitive value that fails (the trace and the
// tool-failure log), asks the user for a password through the secret-input card, then a later turn refers to the code, the
// conversation is compacted and its process ends (the memory ingest of the loaded session), and after a reload one more turn
// runs. Every value below is a test value.

export const MODEL = 'sensitive-writes-model';
/** The mailed code the agent fills with `sensitive: true`; the fill succeeds. */
export const CODE = '482913';
/** A second sensitive value whose fill fails (the field is gone). */
export const FAILED = 'Q7-551902';
/** The password the user types into the secret-input card. Node never receives it (the desktop holds it); the core does. */
export const SECRET = 'Tr0ub4dor&3';
export const ORIGIN = 'https://portal.example';

const fill = (id, ref, text) => ({ id, name: 'browser', args: { action: 'fill', input: { ref, text, sensitive: true } } });

/** The user's prompts, in order; `phase` 1 runs in the first process, 2 after the reload. */
export const TURNS = [
  { phase: 1, prompt: `The portal mailed me ${CODE}. Keep it for the sign-in.` },
  { phase: 1, prompt: `${CODE} is the code from the mail. Sign in to the portal.` },
  { phase: 1, prompt: `Was ${CODE} accepted?` },
  { phase: 2, prompt: 'Which code did you use?' },
];

/**
 * The provider's replies, in the order the provider is asked: one for the turn before the mark, three for the sign-in turn (the
 * two fills, the secret request, the answer), one for the next, one for the turn after the reload. The manual compaction asks no model (Node compacts this
 * conversation by its rules: `compaction ... source=rules`).
 */
export const REPLIES = [
  { text: 'Noted.', calls: [] },
  { text: '', calls: [fill('call_fill_ok', 'e1', CODE), fill('call_fill_bad', 'e2', FAILED)] },
  { text: '', calls: [{ id: 'call_secret', name: 'handoff_user', args: { handoff: { kind: 'secret', surface: 'browser', target: 'Portal password', field: 'password' } } }] },
  { text: 'Signed in.', calls: [] },
  { text: `Yes, ${CODE} was accepted.`, calls: [] },
  { text: 'The code is not shown to me any more.', calls: [] },
];

/**
 * What the desktop's browser answers, per command, in the bridge's form (Node: `{ ok, value | error }` over the discovery
 * bridge) — the core's host gets the same `value` or the same error. The failed fill's error repeats the value it was given,
 * as a page's validation message does, so the failure log's error line holds it unless it is redacted.
 */
/**
 * The page text the successful fill returns: past the tool-history budget of a 128k window (5%, 6400 tokens) and under the
 * 50,000 characters a result is offloaded at (`tool-result-offload.mjs`), so the manual compaction has an execution group to
 * archive (the dump and its per-message blob, `execution-tail.mjs`), the files that would keep the fill's arguments.
 */
const PAGE = Array.from({ length: 650 },(_, i) => `row ${i}: portal session notice, nothing of the code here.`).join('\n');

export function browserAnswer(command) {
  const input = command.input && typeof command.input === 'object' ? command.input : command;
  switch (command.action) {
    case 'fill':
      return input.ref === 'e1' ? { ok: true, value: { text: `Filled e1\n${PAGE}` } } : { ok: false, error: `the field ${input.ref} refused "${input.text}"` };
    case 'secret_bind':
      return { ok: true, value: { origin: ORIGIN, form: 'password' } };
    case 'secret_input':
      return { ok: true, value: { text: 'entered' } };
    default:
      return { ok: false, error: `unexpected command ${command.action}` };
  }
}
