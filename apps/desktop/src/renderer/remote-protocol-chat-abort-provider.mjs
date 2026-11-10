// The model endpoint both abort recordings use (Node's daemon and mixdogd are pointed at the same one): an OpenAI-compatible chat stream on
// loopback whose answer comes from a marker in the prompt, never from time. A turn request (tools offered) whose last user message carries
//   HOLD-EMPTY  streams the assistant role and nothing else, then stays open until the client hangs up (a turn that produced no output);
//   HOLD-TEXT   streams one text delta, then stays open (a turn that produced output);
// anything else (and every request without tools: titles, warm-ups) is answered with a short text and finished.
import http from 'node:http';

export const PARTIAL = 'HOLD-PARTIAL-STREAM';
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
      const held = (body.tools ?? []).length > 0 ? (/HOLD-TEXT/.test(prompt) ? 'text' : /HOLD-EMPTY/.test(prompt) ? 'empty' : null) : null;
      const entry = { prompt, held };
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
      if (held === 'text') res.write(chunk({ content: `${PARTIAL} once upon a time ` }));
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
    /** Resolves with the first held turn request carrying `marker` (already seen or still to come). */
    held: (marker) => new Promise((resolve) => {
      const seen = requests.find((r) => r.held && r.prompt.includes(marker));
      if (seen) return resolve(seen);
      const listener = (entry) => { if (entry.held && entry.prompt.includes(marker)) { listeners.delete(listener); resolve(entry); } };
      listeners.add(listener);
    }),
    close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }),
  };
}
