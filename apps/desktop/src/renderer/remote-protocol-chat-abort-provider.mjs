// The model endpoint both abort recordings use (Node's daemon and mixdogd are pointed at the same one): an OpenAI-compatible chat stream on
// loopback whose answer comes from a marker in the prompt, never from time. A turn request (tools offered) whose last user message carries
//   HOLD-EMPTY  streams the assistant role and nothing else, then stays open until the client hangs up (a turn that produced no output);
//   HOLD-TEXT   streams one text delta, then stays open (a turn that produced output);
//   HOLD-FINAL  streams the whole answer and its finish, then stays open before the stream ends (the answer is committed, the turn is not settled);
//   HOLD-TOOL / HOLD-APPROVAL  answer with a call of the read tool / of a tool that needs an approval, and the request carrying the call's result is held;
//   HOLD-ASK    answers with a call of the read tool on ASKED_FILE (a hook rule asks the person first: remote-protocol-chat-abort-cases.mjs
//               HOOK_RULES), and the request carrying the call's result is answered and finished (the turn ends on its own);
// anything else (and every request without tools: titles, warm-ups) is answered with a short text and finished.
import { createHash } from 'node:crypto';
import http from 'node:http';

export const PARTIAL = 'HOLD-PARTIAL-STREAM';
export const FINAL = 'HOLD-FINAL-ANSWER';
/** The file a HOLD-ASK turn reads: the hook rule that asks before the read names it. */
export const ASKED_FILE = 'ask-me.json';
/** A gated request's kind: its key without the body's length and hash. */
export const kindOf = (key) => key.replace(/ \d+ [0-9a-f]{64}$/, '');
const textOf = (content) => (typeof content === 'string' ? content : Array.isArray(content) ? content.map((p) => p?.text ?? '').join('\n') : '');

/** `gated`: nothing is written until the caller releases it (`releaseNext`, one write at a time, the history recorder's barrier between
 *  inputs); otherwise every write goes out as soon as the request is read. `answered`: of a gated endpoint, the keys written at once. */
export async function startAbortProvider({ gated = false, answered = () => false } = {}) {
  const requests = [];
  const listeners = new Set();
  // The writes not yet released, per request (gated only), and the requests by their key in arrival order of the key.
  const queued = [];
  // Told (after the handler has queued its writes) that a request is waiting.
  const waiters = new Set();
  const gate = (entry, res) => {
    if (!gated || answered(entry.key)) return res;
    const steps = [];
    entry.steps = steps;
    queued.push(entry);
    queueMicrotask(() => { for (const waiter of waiters) waiter(); });
    const later = (op) => (...args) => { steps.push(() => res[op](...args)); };
    return { setHeader: later('setHeader'), writeHead: later('writeHead'), write: later('write'), end: later('end'), on: (...args) => res.on(...args) };
  };
  const server = http.createServer((req, realRes) => {
    if (req.method === 'GET') {
      const res = gate({ key: `GET ${req.url}` }, realRes);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'harness-model', object: 'model' }] }));
      return;
    }
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      const lastUser = [...(body.messages ?? [])].reverse().find((m) => m?.role === 'user');
      const prompt = textOf(lastUser?.content);
      const afterTool = (body.messages ?? []).some((m) => m?.role === 'tool');
      // HOLD-TOOL: the first request answers with a call of the read tool, the request that carries its result is held with no further output.
      const asksTool = (body.tools ?? []).length > 0 && /HOLD-TOOL|HOLD-APPROVAL|HOLD-ASK/.test(prompt) && !afterTool;
      const held = asksTool ? null : (body.tools ?? []).length > 0 ? (/HOLD-TEXT/.test(prompt) ? 'text' : /HOLD-FINAL/.test(prompt) ? 'final' : /HOLD-EMPTY|HOLD-TOOL|HOLD-APPROVAL/.test(prompt) ? 'empty' : null) : null;
      // The key a gated release orders by: what the request is, never when its connection was accepted.
      const entry = { prompt, held, afterTool, asked: asksTool, key: `${req.method} ${req.url} ${body.stream === true ? 'stream' : 'once'} ${(body.tools ?? []).length ? 'tools' : 'plain'} ${afterTool ? 'after-tool' : 'first'} ${raw.length} ${createHash('sha256').update(raw).digest('hex')}` };
      Object.defineProperty(entry, 'raw', { value: raw, enumerable: false });
      requests.push(entry);
      const res = gate(entry, realRes);
      const chunk = (delta, finish = null) => `data: ${JSON.stringify({ id: 'chatcmpl-abort', object: 'chat.completion.chunk', created: 1700000000, model: 'harness-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      if (body.stream !== true) {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ id: 'chatcmpl-abort', object: 'chat.completion', model: 'harness-model', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }));
        for (const listener of listeners) listener(entry);
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write(chunk({ role: 'assistant', content: '' }));
      if (asksTool) {
        const offered = (body.tools ?? []).map((t) => t?.function?.name);
        const approval = /HOLD-APPROVAL/.test(prompt);
        // The read tool runs unasked; ask_user waits for the person through the same hook as a tool approval (turn.mjs:291-296 approveToolRequest).
        const toolName = offered.find((n) => (approval ? /^ask_user$/i : /^read$/i).test(n ?? ''));
        if (!toolName) {
          // Answered as a failed request, never thrown: a throw here would end the recording process before it shut its daemon down.
          process.stderr.write(`the turn offers no ${approval ? 'ask_user' : 'read'} tool (offered: ${offered.join(', ')})\n`);
          res.end();
          return;
        }
        const args = approval
          ? { questions: [{ question: 'Add the file?', header: 'Add file', options: [{ label: 'Yes', description: 'Add it' }, { label: 'No', description: 'Leave it out' }] }] }
          : { path: /HOLD-ASK/.test(prompt) ? ASKED_FILE : 'package.json' };
        res.write(chunk({ tool_calls: [{ index: 0, id: 'call_hold_1', type: 'function', function: { name: toolName, arguments: JSON.stringify(args) } }] }));
        res.write(chunk({}, 'tool_calls'));
        res.write(`data: ${JSON.stringify({ id: 'chatcmpl-abort', object: 'chat.completion.chunk', model: 'harness-model', choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })}\n\n`);
        res.end('data: [DONE]\n\n');
        for (const listener of listeners) listener(entry);
        return;
      }
      if (held === 'text') res.write(chunk({ content: `${PARTIAL} once upon a time ` }));
      if (held === 'final') {
        res.write(chunk({ content: FINAL }));
        res.write(chunk({}, 'stop'));
        res.write(`data: ${JSON.stringify({ id: 'chatcmpl-abort', object: 'chat.completion.chunk', model: 'harness-model', choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })}\n\n`);
      }
      if (held) {
        // Open until the client hangs up (the Stop).
        res.on('close', () => { entry.closedByClient = true; });
      } else {
        res.write(chunk({ content: 'ok' }));
        res.write(chunk({}, 'stop'));
        res.write(`data: ${JSON.stringify({ id: 'chatcmpl-abort', object: 'chat.completion.chunk', model: 'harness-model', choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })}\n\n`);
        res.end('data: [DONE]\n\n');
      }
      for (const listener of listeners) listener(entry);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    baseURL: `http://127.0.0.1:${server.address().port}/v1`,
    requests,
    /** Resolves with the first request that called a tool for the prompt carrying `marker`. */
    asked: (marker) => new Promise((resolve) => {
      const seen = requests.find((r) => r.asked && r.prompt.includes(marker));
      if (seen) return resolve(seen);
      const listener = (entry) => { if (entry.asked && entry.prompt.includes(marker)) { listeners.delete(listener); resolve(entry); } };
      listeners.add(listener);
    }),
    /** Resolves with the `nth` held turn request carrying `marker` (already seen or still to come). */
    held: (marker, nth = 1) => new Promise((resolve) => {
      const matches = (r) => r.held && r.prompt.includes(marker);
      const seen = requests.filter(matches)[nth - 1];
      if (seen) return resolve(seen);
      const listener = () => { const found = requests.filter(matches)[nth - 1]; if (found) { listeners.delete(listener); resolve(found); } };
      listeners.add(listener);
    }),
    /** Gated: releases the next write of the request first by key (then by arrival among equal keys); false when none is waiting. */
    releaseNext: () => {
      const waiting = queued.filter((e) => e.steps.length);
      if (!waiting.length) return false;
      waiting.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : queued.indexOf(a) - queued.indexOf(b)));
      const entry = waiting[0];
      // One call on the response per release (a header set alone writes nothing until the first write).
      entry.steps.shift()();
      entry.released = (entry.released ?? 0) + 1;
      return { key: entry.key, prompt: entry.prompt?.slice(0, 60) ?? entry.key, step: entry.released };
    },
    /** Gated, for a replay of a recorded release: the next write of the first waiting request of `kind` (a key without its body's
     *  length and hash, which are the client's own); false when no such request is waiting yet. */
    release: (kind) => {
      const entry = queued.find((e) => e.steps.length && kindOf(e.key) === kind);
      if (!entry) return false;
      entry.steps.shift()();
      entry.released = (entry.released ?? 0) + 1;
      return { key: entry.key, step: entry.released };
    },
    /** Calls `waiter` whenever a request has queued its writes. */
    onQueued: (waiter) => { waiters.add(waiter); },
    close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }),
  };
}
