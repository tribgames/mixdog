// Input normalisation for the effort judge, applied the same way in training
// (mixdog-effort-judge/clean_text.py mirrors this file character for
// character). The judge sees a short token budget, so text that carries no
// difficulty signal is removed before it can crowd out what does:
//   - fenced code blocks collapse to a "[code]" marker (their presence still counts)
//   - paired tag blocks (<tag ...>...</tag>) are dropped
//   - ANSI colour codes are dropped, long hex runs (hashes) shortened to 7 chars
//   - runs of spaces/tabs become one space, runs of blank lines one newline
// The training data stores the first 1500 characters of a request and the last
// 1000 of the previous reply, so cleaning runs on exactly those windows.
// Lengths count code points, as Python slicing does.

const FENCE = /```+[\s\S]*?(?:```+|$)/g;
const TAG_BLOCK = /<([A-Za-z][A-Za-z0-9_-]*)(?:[ \t\r\n][^>]*)?>[\s\S]*?<\/\1>/g;
const ANSI = /\u001b\[[0-9;]*m/g;
const HEX = /(?<![0-9A-Za-z])[0-9a-fA-F]{12,}(?![0-9A-Za-z])/g;
const SPACES = /[ \t]+/g;
const BLANK_LINES = /\n[ \t]*\n[\n \t]*/g;

export function cleanJudgeText(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(ANSI, '')
    .replace(FENCE, ' [code] ')
    .replace(TAG_BLOCK, ' ')
    .replace(HEX, (m) => m.slice(0, 7))
    .replace(SPACES, ' ')
    .replace(BLANK_LINES, '\n')
    .trim();
}

const head = (text, n) => Array.from(String(text || '')).slice(0, n).join('');
const tail = (text, n) => {
  const cps = Array.from(String(text || ''));
  return cps.slice(Math.max(0, cps.length - n)).join('');
};

/** The judge input for the "rpc" format: cleaned request head, cleaned previous reply tail. */
export function judgeInputClean(request, prev) {
  return `request: ${cleanJudgeText(head(request, 1500))}\nprevious reply: ${cleanJudgeText(tail(prev, 1000))}`;
}

// "pack" format: token-budgeted assembly. Each part is cleaned, encoded on its
// own, and cut to its budget, so the most decision-relevant text survives the
// window: the request, the previous user request (the work a follow-up
// continues), the previous reply's first line (its topic), then as much of the
// reply's END (what a short approval answers) as remains. Training builds the
// same id sequence (clean_text.pack_ids) with the identical tokenizer.
export const PACK_BUDGET = Object.freeze({ request: 64, prevRequest: 24, replyHead: 16 });

/** Split the cleaned previous reply into its first line and the remaining text. */
export function splitReply(reply) {
  const at = reply.indexOf('\n');
  return at < 0 ? [reply, ''] : [reply.slice(0, at), reply.slice(at + 1)];
}

// Step input: the point where a round of tool results has come back and the
// model decides its next move. The turn's request head, the step number, the
// model's text of this round and up to STEP_CALLS calls with their results.
// A result keeps its start and end (where errors and summaries sit); the
// stored window (2000 + 1000 code points) bounds the cleaning work on huge
// outputs. Training builds the same text (clean_text.step_judge_text).
export const STEP_CALLS = 3;

export function stepResultWindow(text) {
  const cps = Array.from(String(text ?? ''));
  return cps.length <= 3000 ? cps.join('') : `${cps.slice(0, 2000).join('')}\n…\n${cps.slice(-1000).join('')}`;
}

/** The judge text for one step: { request, step, plan, calls: [{ name, args, result }] }. */
export function stepJudgeText({ request, step, plan, calls }) {
  const parts = [`step ${step}`, `request: ${cleanJudgeText(head(request, 300))}`];
  const said = cleanJudgeText(tail(plan, 300));
  if (said) parts.push(`plan: ${said}`);
  for (const call of (calls || []).slice(0, STEP_CALLS)) {
    parts.push(`call: ${call.name} ${cleanJudgeText(head(call.args, 160))}`);
    const result = cleanJudgeText(stepResultWindow(call.result));
    parts.push(`result: ${Array.from(result).length > 500 ? `${head(result, 300)} … ${tail(result, 200)}` : result}`);
  }
  return parts.join('\n');
}

/** Token ids (with the tokenizer's prefix/suffix) for the pack format. */
export function packJudgeIds(tokenizer, { request, prevRequest, prev }, maxTokens) {
  const room = maxTokens - tokenizer.prefix.length - tokenizer.suffix.length;
  const req = tokenizer.encode(`request: ${cleanJudgeText(head(request, 1500))}`).slice(0, PACK_BUDGET.request);
  const q = prevRequest
    ? tokenizer.encode(`previous request: ${cleanJudgeText(head(prevRequest, 600))}`).slice(0, PACK_BUDGET.prevRequest)
    : [];
  const [first, rest] = splitReply(cleanJudgeText(tail(prev, 1000)));
  const top = first ? tokenizer.encode(`previous reply: ${first}`).slice(0, PACK_BUDGET.replyHead) : [];
  let left = Math.max(0, room - req.length - q.length - top.length);
  const end = rest && left > 0 ? tokenizer.encode(rest) : [];
  const endIds = end.slice(Math.max(0, end.length - left));
  return [...tokenizer.prefix, ...req, ...q, ...top, ...endIds, ...tokenizer.suffix].slice(0, maxTokens);
}
