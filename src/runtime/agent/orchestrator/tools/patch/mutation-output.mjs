// Model-surface output wrapper shared by the Codex batch and the ordered
// sequence.
import { drainV4AAmbiguityNotices } from './v4a-convert.mjs';

// Model-surface success outputs deliberately carry no `mutation_route:`
// diagnostic header (the surface stays `Success. Updated the following files:`);
// no script/UI parses one, and dropping it saves ~30 tokens per successful patch call.
export function wrapPatchMutationOutput(text) {
  // Per-file success rows already identify the edits; retain warnings/errors.
  text = text.replace(/^Applied \d+ Files? \((?:Native|JS)\)\r?\n(?= {2}OK )/gm, '');
  // Non-fatal duplicate-context notices ride the success output: the edit
  // landed at the first match (spec), and the caller learns in the same turn
  // that another location was possible.
  const notices = drainV4AAmbiguityNotices();
  if (notices.length === 0) return text;
  return `${text}\n${notices.map((notice) => `⚠️ ${notice}`).join('\n')}`;
}
