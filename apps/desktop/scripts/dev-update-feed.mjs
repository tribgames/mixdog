// Local update feed for the dev loop: serves the electron-builder output
// (latest.yml + installer + blockmap) over 127.0.0.1 so the SHIPPING updater
// code path (electron-updater generic provider) can run against a build made
// from this working tree. Range requests are honoured because the differential
// downloader asks for them; anything it cannot use falls back to a full
// download on its own.
import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';

const args = new Map(process.argv.slice(2).map((value) => {
  const index = value.indexOf('=');
  return index < 0
    ? [value.replace(/^--/, ''), 'true']
    : [value.slice(2, index), value.slice(index + 1)];
}));
const root = resolve(String(args.get('dir') || process.cwd()));
const port = Number(args.get('port')) || 9357;
const TYPES = {
  '.yml': 'text/yaml',
  '.yaml': 'text/yaml',
  '.json': 'application/json',
  '.exe': 'application/octet-stream',
  '.blockmap': 'application/octet-stream',
};

const server = createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const target = normalize(join(root, decodeURIComponent(url.pathname)));
  if (!target.startsWith(root)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  let info;
  try {
    info = statSync(target);
  } catch {
    res.writeHead(404).end('not found');
    return;
  }
  if (!info.isFile()) {
    res.writeHead(404).end('not found');
    return;
  }
  const type = TYPES[extname(target).toLowerCase()] || 'application/octet-stream';
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Number(range[2]) : info.size - 1;
    res.writeHead(206, {
      'Content-Type': type,
      'Content-Length': String(end - start + 1),
      'Content-Range': `bytes ${start}-${end}/${info.size}`,
      'Accept-Ranges': 'bytes',
    });
    if (req.method === 'HEAD') { res.end(); return; }
    createReadStream(target, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': String(info.size),
    'Accept-Ranges': 'bytes',
  });
  if (req.method === 'HEAD') { res.end(); return; }
  createReadStream(target).pipe(res);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`dev update feed on http://127.0.0.1:${port} (${root})`);
});
