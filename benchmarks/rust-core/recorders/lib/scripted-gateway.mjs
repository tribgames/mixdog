// A scripted local HTTP gateway for the recorders that need held or ordered answers: every request is recorded as it arrived (method,
// url, header pairs in arrival order, parsed body), answered by `respond(req, body, res, n)` (n = 1-based arrival number), and
// `arrived(n)` resolves when the n-th request has arrived (no polling). `responded(n)` resolves once its answer was ended.
import { createServer } from 'node:http';

export async function gateway(respond) {
  const requests = [];
  const waiters = new Map();
  const answered = new Map();
  const wait = (map, n) => new Promise((resolve) => map.set(n, [...(map.get(n) ?? []), resolve]));
  const fire = (map, n) => {
    for (const resolve of map.get(n) ?? []) resolve();
    map.delete(n);
  };
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      const headers = [];
      for (let i = 0; i < req.rawHeaders.length; i += 2) headers.push([req.rawHeaders[i].toLowerCase(), req.rawHeaders[i + 1]]);
      requests.push({ method: req.method, url: req.url, headers, body });
      const n = requests.length;
      res.on('finish', () => fire(answered, n));
      fire(waiters, n);
      respond(req, body, res, n);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    requests,
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    arrived: (n) => (requests.length >= n ? Promise.resolve() : wait(waiters, n)),
    responded: (n) => (answered.has(`done${n}`) ? Promise.resolve() : wait(answered, n)),
    close: () => {
      server.closeAllConnections();
      server.close();
    },
    // The port differs per run: it is written <gw> wherever it appears in a recorded value.
    scrub: (value) => JSON.parse(JSON.stringify(value ?? null).replaceAll('127.0.0.1:' + server.address().port, '<gw>')),
  };
}

export const json = (res, status, doc) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(doc));
};
