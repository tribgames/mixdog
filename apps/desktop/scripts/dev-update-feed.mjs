// Local update feed for the dev loop: serves the electron-builder output
// (latest.yml + installer + blockmap) over 127.0.0.1 so the SHIPPING updater
// code path (electron-updater generic provider) can run against a build made
// from this working tree. Range requests are honoured because the differential
// downloader asks for them; anything it cannot use falls back to a full
// download on its own.
import { createReadStream, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, isAbsolute, join, normalize, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The file a request path names inside `root`, or null when it escapes it
 *  (a sibling folder that merely shares the prefix included) or is malformed. */
export function feedFilePath(root, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const target = normalize(join(root, decoded));
  const fromRoot = relative(root, target);
  if (fromRoot.startsWith('..') || isAbsolute(fromRoot)) return null;
  return target;
}

/** One `bytes=` range against a file of `size` bytes: null serves the whole
 *  file, 'unsatisfiable' answers 416, otherwise the inclusive, clamped span. */
export function feedByteRange(header, size) {
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(header || ''));
  if (!range || (!range[1] && !range[2])) return null;
  let start;
  let end;
  if (!range[1]) {
    // Suffix range: the last N bytes.
    const length = Number(range[2]);
    if (length === 0 || size === 0) return 'unsatisfiable';
    start = Math.max(0, size - length);
    end = size - 1;
  } else {
    start = Number(range[1]);
    end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
  }
  if (start >= size || start > end) return 'unsatisfiable';
  return { start, end };
}

const TYPES = {
  '.yml': 'text/yaml',
  '.yaml': 'text/yaml',
  '.json': 'application/json',
  '.exe': 'application/octet-stream',
  '.blockmap': 'application/octet-stream',
};

function serveFeed(root, req, res) {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const target = feedFilePath(root, url.pathname);
  if (!target) {
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
  const range = feedByteRange(req.headers.range, info.size);
  if (range === 'unsatisfiable') {
    res.writeHead(416, { 'Content-Range': `bytes */${info.size}` }).end();
    return;
  }
  if (range) {
    const { start, end } = range;
    res.writeHead(206, {
      'Content-Type': type,
      'Content-Length': String(end - start + 1),
      'Content-Range': `bytes ${start}-${end}/${info.size}`,
      'Accept-Ranges': 'bytes',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    createReadStream(target, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': String(info.size),
    'Accept-Ranges': 'bytes',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  createReadStream(target).pipe(res);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const args = new Map(
    process.argv.slice(2).map((value) => {
      const index = value.indexOf('=');
      return index < 0 ? [value.replace(/^--/, ''), 'true'] : [value.slice(2, index), value.slice(index + 1)];
    })
  );
  const root = resolve(String(args.get('dir') || process.cwd()));
  const port = Number(args.get('port')) || 9357;
  createServer((req, res) => serveFeed(root, req, res)).listen(port, '127.0.0.1', () => {
    console.log(`dev update feed on http://127.0.0.1:${port} (${root})`);
  });
}
