// A local scripted OpenAI chat-completions endpoint (SSE), after the ft harness's startProvider. No real model,
// no credentials: the instance's config names it as a custom provider with auth none.
//
// An answer is one of:
//   { calls: [{ name, args }] }                        tool calls
//   { text }                                           one short text answer
//   { stream: { text, chunks, intervalMs } }           a long streamed answer (R2 situation d)
//   { status, json }                                   an HTTP error
// `state.decide(body, n, entry)` picks the answer of the n-th chat request; otherwise a FIFO `state.queue`; an empty
// queue answers { text: 'done' }.
import { createServer } from 'node:http';
import zlib from 'node:zlib';

import { CUSTOM } from './paths.mjs';

const chunk = (delta, finish = null) => ({ id: 'scripted', object: 'chat.completion.chunk', created: 0, model: 'smoke', choices: [{ index: 0, delta, finish_reason: finish }] });
const frame = (c) => `data: ${typeof c === 'string' ? c : JSON.stringify(c)}\n\n`;

/**
 * `$REF:<regex>` in a call's args becomes the ref of the first line of the last tool result matching the regex
 * (`[ref=e12]` / `ref=e12` forms), so a scripted click can name an element a snapshot just reported.
 */
function resolveTemplates(value, results) {
  if (typeof value === 'string' && value.startsWith('$REF:')) {
    const pattern = new RegExp(value.slice(5), 'i');
    for (const text of [...results].reverse()) {
      for (const line of String(text).split(/\\n|\n/)) {
        if (!pattern.test(line)) continue;
        // Snapshot lines: `[p1-s1-e3]* textbox "Query"`; older forms `ref=e12`.
        const m = /\[([A-Za-z0-9_:-]+)\]\*?\s/.exec(line) ?? /\bref[=:]\s*"?([A-Za-z0-9_:-]+)/.exec(line);
        if (m) return m[1];
      }
    }
    return `unresolved(${value.slice(5)})`;
  }
  if (Array.isArray(value)) return value.map((v) => resolveTemplates(v, results));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveTemplates(v, results)]));
  return value;
}

/** A short view of a request for the control API (no full bodies: those can be large). */
const requestView = (r, i) => ({
  i,
  at: r.at,
  url: r.url,
  tools: Array.isArray(r.body?.tools) ? r.body.tools.map((t) => t.function?.name ?? t.name).filter(Boolean) : undefined,
  lastToolResults: r.body ? lastToolResults(r.body).map((t) => t.slice(0, 4000)) : undefined,
  answer: r.answer ? { kind: r.answer.calls ? 'calls' : r.answer.stream ? 'stream' : r.answer.status ? 'status' : 'text', calls: r.answer.calls, tag: r.answer.tag } : undefined,
  streamStartedAt: r.streamStartedAt,
  streamEndedAt: r.streamEndedAt,
});

export function startProvider() {
  const requests = [];
  const waiters = [];
  const state = { queue: [], routes: [], decide: null, callSeq: 0 };
  const server = createServer((req, res) => {
    const parts = [];
    req.on('data', (d) => parts.push(d));
    req.on('end', async () => {
      // Control API (the holder process keeps the provider; runners push scripted answers here).
      if (req.url.startsWith('/__control/')) {
        const json = (status, value) => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(value));
        };
        const body = parts.length ? JSON.parse(Buffer.concat(parts).toString('utf8')) : {};
        if (req.url === '/__control/queue') {
          state.queue.push(...(body.answers ?? []));
          return json(200, { queued: state.queue.length });
        }
        if (req.url === '/__control/route') {
          state.routes.push({ match: body.match, answers: [...(body.answers ?? [])] });
          return json(200, { routes: state.routes.length });
        }
        if (req.url === '/__control/reset') {
          state.queue.length = 0;
          state.routes.length = 0;
          return json(200, { ok: true, requests: requests.length });
        }
        if (req.url.startsWith('/__control/requests')) {
          const since = Number(new URL(req.url, 'http://x').searchParams.get('since') ?? 0);
          return json(200, { total: requests.length, queued: state.queue.length, requests: requests.slice(since).map((r, k) => requestView(r, since + k)) });
        }
        return json(404, { error: 'unknown control' });
      }
      if (req.method === 'GET' && req.url.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'smoke', object: 'model' }] }));
        return;
      }
      const raw = Buffer.concat(parts);
      let body = raw.toString('utf8');
      const enc = req.headers['content-encoding'];
      try {
        if (enc === 'gzip') body = zlib.gunzipSync(raw).toString('utf8');
        else if (enc === 'zstd' && zlib.zstdDecompressSync) body = zlib.zstdDecompressSync(raw).toString('utf8');
        else if (enc === 'br') body = zlib.brotliDecompressSync(raw).toString('utf8');
      } catch {}
      let parsed = null;
      try {
        parsed = JSON.parse(body);
      } catch {}
      if (!parsed) {
        requests.push({ method: req.method, url: req.url, body: null, raw: body.slice(0, 300), at: Date.now() });
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end('{}');
        return;
      }
      const entry = { method: req.method, url: req.url, body: parsed, at: Date.now() };
      requests.push(entry);
      for (const w of waiters.splice(0)) w(entry);
      const n = requests.length;
      let answer;
      try {
        answer = state.decide ? await state.decide(parsed, n, entry) : undefined;
      } catch (error) {
        answer = { text: `decide failed: ${error.message}` };
      }
      // A routed answer first: the queue of the first route whose `match` the request's messages contain (a thread's
      // own prompt stays in every later request of it), so concurrent turns of different threads get their own scripts.
      if (!answer && state.routes.length) {
        const text = JSON.stringify(parsed.messages ?? []);
        const route = state.routes.find((r) => r.answers.length && text.includes(r.match));
        if (route) answer = route.answers.shift();
      }
      answer ??= state.queue.shift() ?? { text: 'done' };
      if (answer.calls) answer = { ...answer, calls: resolveTemplates(answer.calls, lastToolResults(parsed)) };
      if (answer.delayMs) await new Promise((r) => setTimeout(r, answer.delayMs));
      entry.answer = answer;
      if (answer.status) {
        res.writeHead(answer.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(answer.json ?? { error: { message: 'scripted error' } }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      if (answer.calls) {
        const toolCalls = answer.calls.map((c, index) => ({
          index,
          id: `call_${++state.callSeq}`,
          type: 'function',
          function: { name: c.name, arguments: typeof c.args === 'string' ? c.args : JSON.stringify(c.args) },
        }));
        res.write(frame(chunk({ role: 'assistant', content: answer.text ?? null, tool_calls: toolCalls })));
        res.write(frame(chunk({}, 'tool_calls')));
        res.end(frame('[DONE]'));
      } else if (answer.stream) {
        const { text = 'lorem ipsum ', chunks = 200, intervalMs = 50 } = answer.stream;
        entry.streamStartedAt = Date.now();
        res.write(frame(chunk({ role: 'assistant', content: '' })));
        for (let i = 0; i < chunks; i += 1) {
          if (res.destroyed) break;
          res.write(frame(chunk({ content: `${i}:${text}` })));
          await new Promise((r) => setTimeout(r, intervalMs));
        }
        res.write(frame(chunk({}, 'stop')));
        res.end(frame('[DONE]'));
        entry.streamEndedAt = Date.now();
      } else {
        res.write(frame(chunk({ role: 'assistant', content: answer.text ?? 'done' })));
        res.write(frame(chunk({}, 'stop')));
        res.end(frame('[DONE]'));
      }
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        baseURL: `http://127.0.0.1:${port}`,
        port,
        requests,
        state,
        chats: () => requests.filter((r) => r.body && r.url.endsWith('/chat/completions')),
        nextRequest: () => new Promise((r) => waiters.push(r)),
        close: () => new Promise((r) => {
          server.closeAllConnections();
          server.close(r);
        }),
      });
    });
  });
}

/** The same control surface over HTTP, for a runner attached to a holder process's provider. */
export function providerControl(baseURL) {
  const post = (path, body) => fetch(`${baseURL}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) }).then((r) => r.json());
  return {
    baseURL,
    push: (answers) => post('/__control/queue', { answers }),
    route: (match, answers) => post('/__control/route', { match, answers }),
    reset: () => post('/__control/reset'),
    requests: (since = 0) => fetch(`${baseURL}/__control/requests?since=${since}`).then((r) => r.json()),
  };
}

/** The config the instance starts with: the scripted endpoint as its only provider. */
export const providerConfig = (baseURL) => ({
  agent: { providers: { [CUSTOM]: { type: 'custom', name: 'smoke', protocol: 'openai-chat', baseURL, auth: 'none', models: [{ id: 'smoke' }] } } },
});

/** The tool results the request at the end of `messages` carries after the last assistant tool_calls message. */
export function lastToolResults(body) {
  const msgs = body?.messages ?? [];
  let at = -1;
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    if (msgs[i].role === 'assistant' && msgs[i].tool_calls?.length) {
      at = i;
      break;
    }
  }
  if (at < 0) return [];
  const text = (m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
  return msgs.slice(at + 1).filter((m) => m.role === 'tool').map(text);
}
