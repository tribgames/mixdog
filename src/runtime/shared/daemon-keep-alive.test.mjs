import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import test from 'node:test';

import { DAEMON_KEEP_ALIVE_MS, createDaemonHttpServer } from './daemon-keep-alive.mjs';

test('the daemon server advertises and applies the shared keep-alive window', async (t) => {
  const server = createDaemonHttpServer((_req, res) => res.end('ok'));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const agent = new http.Agent({ keepAlive: true });
  t.after(() => {
    agent.destroy();
    server.close();
  });

  const res = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: server.address().port, agent }, resolve).on('error', reject);
  });
  res.resume();

  assert.equal(server.keepAliveTimeout, DAEMON_KEEP_ALIVE_MS);
  assert.equal(res.headers['keep-alive'], `timeout=${DAEMON_KEEP_ALIVE_MS / 1000}`);
});
