// Local fixture pages (no public sites): a form page with no iframe, a page with a cross-origin iframe served from
// 127.0.0.2 (as host-integration-fixtures.ts's /frames), a submit target and a slow page for the cancel case.
import { createServer } from 'node:http';

const html = (title, body) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;

function listen(server, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => resolve(server.address().port));
  });
}

export async function startFixtures() {
  let framePort = 0;
  const main = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const send = (status, body, type = 'text/html; charset=utf-8') => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(body);
    };
    if (url.pathname === '/form') {
      return send(
        200,
        html(
          'lat form',
          `<h1>Latency form</h1>
<form id="f" action="/submitted" method="get">
  <label>Query <input id="q" name="q" type="text" autocomplete="off"></label>
  <label>Notes <textarea id="t" name="t" rows="3"></textarea></label>
  <button id="go" type="submit">Search</button>
</form>
<button id="plain" type="button" onclick="document.getElementById('out').textContent='clicked '+Date.now()">Plain button</button>
<p id="out"></p>`
        )
      );
    }
    if (url.pathname === '/frames') {
      return send(
        200,
        html(
          'lat frames',
          `<h1>Frames</h1>
<button id="plain" type="button" onclick="document.getElementById('out').textContent='clicked '+Date.now()">Plain button</button>
<p id="out"></p>
<iframe title="cross origin" src="http://127.0.0.2:${framePort}/inner" width="400" height="160"></iframe>`
        )
      );
    }
    if (url.pathname === '/submitted') return send(200, html('lat submitted', `<h1>Submitted</h1><p id="q">${encodeURIComponent(url.searchParams.get('q') ?? '')}</p>`));
    if (url.pathname === '/slow') {
      // The cancel case: a page whose load takes `ms`.
      const ms = Number(url.searchParams.get('ms') ?? 30000);
      setTimeout(() => send(200, html('lat slow', '<h1>slow done</h1>')), ms);
      return;
    }
    if (url.pathname === '/root') return send(200, JSON.stringify({ q: url.searchParams.get('q') }), 'application/json');
    return send(200, html('lat blank', '<p>blank</p>'));
  });
  const frame = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(html('lat inner', `<button id="inner" type="button" onclick="this.textContent='inner clicked'">Inner button</button>`));
  });
  const port = await listen(main, '127.0.0.1');
  framePort = await listen(frame, '127.0.0.2');
  const origin = `http://127.0.0.1:${port}`;
  return {
    origin,
    frameOrigin: `http://127.0.0.2:${framePort}`,
    url: (path) => `${origin}${path}`,
    close: () => Promise.all([main, frame].map((s) => new Promise((r) => {
      s.closeAllConnections?.();
      s.close(r);
    }))),
  };
}
