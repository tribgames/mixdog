// A scripted OpenAI-compatible chat endpoint on loopback: no key, no network, no delays. Every chat request is answered with the
// scenario's streamed text; a GET lists the one model.
import http from 'node:http';
import { SCENARIO } from './scenarios.mjs';

export const FAKE_MODEL = 'harness-model';

export async function startFakeProvider({ workspace }) {
  const requests = [];
  const server = http.createServer((req, res) => {
    if (req.method === 'GET') {
      requests.push({ seq: requests.length + 1, method: 'GET', url: req.url, kind: 'get' });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ object: 'list', data: [{ id: FAKE_MODEL, object: 'model' }] }));
      return;
    }
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let body = {};
      try { body = JSON.parse(raw || '{}'); } catch { body = { unparsable: raw }; }
      const plan = SCENARIO.respond({ workspace, body });
      requests.push({ seq: requests.length + 1, method: req.method, url: req.url, kind: plan.kind, auth: req.headers.authorization ?? null, body });
      const chunk = (delta, finish = null) => `data: ${JSON.stringify({ id: 'chatcmpl-harness', object: 'chat.completion.chunk', created: 1700000000, model: FAKE_MODEL, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      const usage = { prompt_tokens: 1200, completion_tokens: 24, total_tokens: 1224 };
      if (body.stream !== true) {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ id: 'chatcmpl-harness', object: 'chat.completion', model: FAKE_MODEL, choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write(chunk({ role: 'assistant', content: '' }));
      for (const delta of plan.deltas) res.write(chunk(delta));
      res.write(chunk({}, plan.finish));
      res.write(`data: ${JSON.stringify({ id: 'chatcmpl-harness', object: 'chat.completion.chunk', model: FAKE_MODEL, choices: [], usage })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    baseURL: `http://127.0.0.1:${server.address().port}/v1`,
    requests,
    close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }),
  };
}
