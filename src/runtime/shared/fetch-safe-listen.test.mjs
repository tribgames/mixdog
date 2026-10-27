import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { FETCH_BLOCKED_PORTS, listenOnFetchSafePort } from './fetch-safe-listen.mjs';

const listening = (server, options) =>
  new Promise((resolve, reject) => {
    server.once('error', reject);
    listenOnFetchSafePort(server, '127.0.0.1', resolve, options);
  });

// The OS assigns a real port; `portOf` reports the blocked ports the OS did not
// hand out, so the retry path runs deterministically.
const reportingFirst = (blocked) => {
  const reported = [];
  const queue = [...blocked];
  return {
    reported,
    portOf: (server) => {
      const port = queue.length ? queue.shift() : server.address().port;
      reported.push(port);
      return port;
    },
  };
};

test('the blocked ports are exactly the Fetch spec list', () => {
  // https://fetch.spec.whatwg.org/#port-blocking
  const specList = [
    0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109,
    110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531,
    532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060,
    5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
  ];
  assert.deepEqual(
    [...FETCH_BLOCKED_PORTS].sort((a, b) => a - b),
    specList
  );
  assert.equal(FETCH_BLOCKED_PORTS.has(8080), false);
});

test('a blocked first port is closed and the server settles on a safe port fetch can reach', async () => {
  const server = createServer((_request, response) => response.end('ok'));
  const { reported, portOf } = reportingFirst([6667, 6668]);
  let closes = 0;
  server.on('close', () => {
    closes += 1;
  });
  try {
    await listening(server, { portOf });
    assert.equal(server.listening, true);
    assert.equal(closes, 2, 'each blocked port closed the server');
    assert.equal(reported.length, 3);
    const { port } = server.address();
    assert.equal(FETCH_BLOCKED_PORTS.has(port), false);
    const response = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(await response.text(), 'ok');
  } finally {
    server.close();
  }
});

test('exhausted attempts close the server and surface a listen error', async () => {
  const server = createServer();
  const alwaysBlocked = { attempts: 2, portOf: () => 6667 };
  await assert.rejects(listening(server, alwaysBlocked), /no fetch-safe loopback port/);
  assert.equal(server.listening, false);
});

test('a server stopped during the retry is not listened again', async () => {
  const server = createServer();
  let current = true;
  const portOf = () => {
    current = false;
    return 6667;
  };
  listenOnFetchSafePort(server, '127.0.0.1', () => assert.fail('must not report listening'), {
    portOf,
    isCurrent: () => current,
  });
  await new Promise((resolve) => server.once('close', resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(server.listening, false);
});
