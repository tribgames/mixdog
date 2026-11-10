// The model endpoint both abort recordings use (Node's daemon and mixdogd are pointed at the same one): an OpenAI-compatible chat stream on
// loopback whose answer comes from a marker in the prompt, never from time. A turn request (tools offered) whose last user message carries
//   HOLD-EMPTY  streams the assistant role and nothing else, then stays open until the client hangs up (a turn that produced no output);
//   HOLD-TEXT   streams one text delta, then stays open (a turn that produced output);
//   HOLD-FINAL  streams the whole answer and its finish, then stays open before the stream ends (the answer is committed, the turn is not settled);
//   HOLD-TOOL / HOLD-APPROVAL  answer with a call of the read tool / of a tool that needs an approval, and the request carrying the call's result is held;
// anything else (and every request without tools: titles, warm-ups) is answered with a short text and finished.
import http from 'node:http';

export const PARTIAL = 'HOLD-PARTIAL-STREAM';
export const FINAL = 'HOLD-FINAL-ANSWER';
const textOf = (content) => (typeof content === 'string' ? content : Array.isArray(content) ? content.map((p) => p?.text ?? '').join('\n') : '');

export async function startAbortProvider() {
  const requests = [];
  const listeners = new Set();
  const server = http.createServer((req, res) => {
    if (req.method === 'GET') {
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
      const asksTool = (body.tools ?? []).length > 0 && /HOLD-TOOL|HOLD-APPROVAL/.test(prompt) && !afterTool;
      const held = asksTool ? null : (body.tools ?? []).length > 0 ? (/HOLD-TEXT/.test(prompt) ? 'text' : /HOLD-FINAL/.test(prompt) ? 'final' : /HOLD-EMPTY|HOLD-TOOL|HOLD-APPROVAL/.test(prompt) ? 'empty' : null) : null;
      const entry = { prompt, held, afterTool, asked: asksTool };
      requests.push(entry);
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
        const args = approval ? { questions: [{ question: 'Add the file?', header: 'Add file', options: [{ label: 'Yes', description: 'Add it' }, { label: 'No', description: 'Leave it out' }] }] } : { path: 'package.json' };
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
    close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }),
  };
}
