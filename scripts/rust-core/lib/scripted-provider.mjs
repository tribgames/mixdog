// A scripted OpenAI chat-completions endpoint for the smoke: the first model request answers with one tool call, every
// later request answers with plain text. It records what the core sent.
import { createServer } from 'node:http';

const sse = (res, chunks) => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  for (const chunk of chunks) res.write(`data: ${typeof chunk === 'string' ? chunk : JSON.stringify(chunk)}\n\n`);
  res.end();
};
const chunk = (delta, finish = null) => ({ id: 'scripted', object: 'chat.completion.chunk', created: 0, model: 'smoke', choices: [{ index: 0, delta, finish_reason: finish }] });

/**
 * @param {{ tool: string, args: string }} call the one tool call the first request answers with (`args` is the raw JSON string)
 * @returns {Promise<{ baseURL: string, requests: object[], toolResult: Promise<object>, close: () => Promise<void> }>}
 *   `toolResult` settles with the second chat request, the one that carries the tool's result back: the tool has run.
 */
export function startScriptedProvider({ tool, args }) {
  const requests = [];
  let sawToolResult;
  const toolResult = new Promise((resolveSeen) => (sawToolResult = resolveSeen));
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (data) => (body += data));
    req.on('end', () => {
      if (req.method === 'GET' && req.url.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'smoke', object: 'model' }] }));
        return;
      }
      requests.push({ method: req.method, url: req.url, body });
      const first = requests.filter((r) => r.url.endsWith('/chat/completions')).length === 1;
      if (first) {
        sse(res, [chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_smoke', type: 'function', function: { name: tool, arguments: args } }] }), chunk({}, 'tool_calls'), '[DONE]']);
      } else {
        sawToolResult(requests.at(-1));
        sse(res, [chunk({ role: 'assistant', content: 'done' }), chunk({}, 'stop'), '[DONE]']);
      }
    });
  });
  return new Promise((resolveStart, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolveStart({
        baseURL: `http://127.0.0.1:${port}`,
        requests,
        toolResult,
        close: () => new Promise((resolveClose) => {
          server.closeAllConnections();
          server.close(resolveClose);
        }),
      });
    });
  });
}
