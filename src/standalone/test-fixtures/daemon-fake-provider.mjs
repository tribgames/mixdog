// A scripted OpenAI-compatible chat endpoint on loopback, for turns the daemon
// runs through a *custom provider* (a feature both v1.4.5 and HEAD have: the
// provider is declared in mixdog-config.json, see writeCustomProviderConfig).
// Every chat request is answered as one streamed assistant message after a
// fixed delay; `waitFor(token)` resolves when the request whose last user
// message contains `token` has been fully answered, so a driver can time a
// turn end to end without any model, network or credential.
import { writeFileSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';

export const FAKE_PROVIDER_ID = 'custom-bench';
export const FAKE_MODEL = 'bench-model';
const TOKEN = /BENCH-[A-Z]+-[A-Za-z0-9_-]+/;

const lastUserText = (messages) => {
  const user = [...(messages || [])].reverse().find((message) => message?.role === 'user');
  const content = user?.content;
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.map((part) => part?.text ?? '').join('\n') : '';
};

export async function startFakeProvider({ replyMs = 400 } = {}) {
  const stats = { requests: 0, answered: 0, modelListings: 0, errors: 0 };
  const waiting = new Map();
  const done = new Set();
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url.startsWith('/v1/models')) {
      stats.modelListings += 1;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ object: 'list', data: [{ id: FAKE_MODEL, object: 'model' }] }));
      return;
    }
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      stats.requests += 1;
      let request = {};
      try {
        request = JSON.parse(body || '{}');
      } catch {
        stats.errors += 1;
      }
      const token = TOKEN.exec(lastUserText(request.messages))?.[0] ?? null;
      const chunk = (delta, finish = null) =>
        `data: ${JSON.stringify({
          id: 'chatcmpl-bench',
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: FAKE_MODEL,
          choices: [{ index: 0, delta, finish_reason: finish }],
        })}\n\n`;
      const usage = { prompt_tokens: 1200, completion_tokens: 24, total_tokens: 1224 };
      const finish = () => {
        stats.answered += 1;
        if (token) {
          done.add(token);
          waiting.get(token)?.();
          waiting.delete(token);
        }
      };
      if (request.stream !== true) {
        setTimeout(() => {
          res.setHeader('content-type', 'application/json');
          res.end(
            JSON.stringify({
              id: 'chatcmpl-bench',
              object: 'chat.completion',
              model: FAKE_MODEL,
              choices: [{ index: 0, message: { role: 'assistant', content: 'Bench reply.' }, finish_reason: 'stop' }],
              usage,
            })
          );
          finish();
        }, replyMs);
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write(chunk({ role: 'assistant', content: '' }));
      setTimeout(() => res.write(chunk({ content: 'Bench reply ' })), replyMs / 2);
      setTimeout(() => {
        res.write(chunk({ content: 'for the load test.' }));
        res.write(chunk({}, 'stop'));
        res.write(
          `data: ${JSON.stringify({ id: 'chatcmpl-bench', object: 'chat.completion.chunk', model: FAKE_MODEL, choices: [], usage })}\n\n`
        );
        res.end('data: [DONE]\n\n');
        finish();
      }, replyMs);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    stats,
    /** Resolves true when the request carrying `token` was answered, false after `timeoutMs`. */
    waitFor(token, timeoutMs = 30_000) {
      if (done.has(token)) return Promise.resolve(true);
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          waiting.delete(token);
          resolve(false);
        }, timeoutMs);
        waiting.set(token, () => {
          clearTimeout(timer);
          resolve(true);
        });
      });
    },
    // Keep-alive connections from the daemon would hold `close` open.
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  };
}

/** Declares the fake endpoint as a no-auth custom provider (config schema v2)
 *  in the isolated data dir, the way `saveCustomProvider` would store it. */
export function writeCustomProviderConfig(dataDir, baseURL) {
  const config = {
    agent: {
      providers: {
        [FAKE_PROVIDER_ID]: {
          type: 'custom',
          schemaVersion: 2,
          name: 'bench',
          protocol: 'openai-chat',
          baseURL,
          auth: 'none',
          enabled: true,
          modelOverrides: { [FAKE_MODEL]: { manual: true } },
        },
      },
    },
  };
  writeFileSync(join(dataDir, 'mixdog-config.json'), JSON.stringify(config, null, 2));
}
