// Records what the Node static file module answers, for tests/web_static.rs.
// Run: node static_files_record.mjs <apps/relay/lib directory of a Node checkout> <scratch directory> <output json>
// It builds the fixture tree `fixture-tree.json` describes (the Rust test builds the same bytes), runs sendStaticFile,
// sendDeviceManifest, resolveStaticTarget, selectPrecompressed, encodingAccepted and the cookie helpers on it, and writes the
// statuses, header lists (in the order Node wrote them), body digests and return values.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';

const [lib, scratch, output] = process.argv.slice(2);
const mod = await import(pathToFileURL(join(lib, 'static-http.mjs')).href);
const tree = JSON.parse(readFileSync(new URL('./fixtures/static-files.tree.json', import.meta.url), 'utf8'));

rmSync(scratch, { recursive: true, force: true });
const rootOf = (name) => join(scratch, name);
for (const [name, files] of Object.entries(tree.roots)) {
  for (const [path, spec] of Object.entries(files)) {
    const bytes = (spec.prefix ?? "") + spec.text.repeat(spec.repeat ?? 1);
    mkdirSync(dirname(join(rootOf(name), path)), { recursive: true });
    writeFileSync(join(rootOf(name), path), bytes);
  }
}

const sha = (buffer) => createHash('sha256').update(buffer).digest('hex');
const listOf = (headers) =>
  Object.entries(headers).map(([name, value]) => [name, Array.isArray(value) ? value.map(String) : String(value)]);

/** Runs `fn(request, response)` with a request of `method`/`headers` and records what it wrote. */
async function exchange(method, headers, fn, encrypted = false) {
  const sink = new PassThrough();
  const chunks = [];
  sink.on('data', (chunk) => chunks.push(chunk));
  const result = { status: 0, headers: [] };
  sink.writeHead = (status, written) => {
    result.status = status;
    result.headers = listOf(written);
  };
  sink.destroy = () => {};
  const finished = new Promise((resolve) => sink.on('end', resolve));
  fn({ method, headers, socket: { encrypted } }, sink);
  await finished;
  const body = Buffer.concat(chunks);
  const live = body.length > 0 && result.headers.some(([name, value]) => name === 'Content-Encoding' && value === 'gzip')
    && !result.headers.some(([name]) => name === 'Content-Length');
  result.body = live
    ? { kind: 'live-gzip', length: gunzipSync(body).length, sha256: sha(gunzipSync(body)) }
    : { kind: 'raw', length: body.length, sha256: sha(body) };
  return result;
}

const out = { files: [], manifests: [], resolve: [], negotiation: [], accepted: [], cookies: [], credentials: [] };

for (const spec of tree.cases) {
  const target = join(rootOf(spec.root), spec.file);
  const headers = { ...spec.headers };
  if (spec.ifNoneMatchOf) {
    const first = out.files.find((entry) => entry.name === spec.ifNoneMatchOf);
    const etag = first.headers.find(([name]) => name === 'ETag')[1];
    headers['if-none-match'] = spec.ifNoneMatchPrefix ? `${spec.ifNoneMatchPrefix}${etag.replace('W/', '')}` : etag;
  }
  const result = await exchange(spec.method ?? 'GET', headers, (req, res) =>
    mod.sendStaticFile(req, res, target, spec.extra ?? {}, { varyOnCookie: !!spec.varyOnCookie })
  );
  out.files.push({ name: spec.name, input: { ...spec, headers }, ...result });
}

for (const spec of tree.manifests) {
  const target = join(rootOf(spec.root), spec.file);
  const headers = { ...spec.headers };
  if (spec.ifNoneMatchOf) {
    const first = out.manifests.find((entry) => entry.name === spec.ifNoneMatchOf);
    headers['if-none-match'] = first.headers.find(([name]) => name === 'ETag')[1];
  }
  const result = await exchange(spec.method ?? 'GET', headers, (req, res) =>
    mod.sendDeviceManifest(req, res, target, spec.device)
  , !!spec.encrypted);
  out.manifests.push({ name: spec.name, input: { ...spec, headers }, ...result });
}

for (const [root, pathname] of tree.resolve) {
  const found = mod.resolveStaticTarget(rootOf(root), pathname);
  out.resolve.push({ root, pathname, status: found.status, target: found.target ? found.target.slice(rootOf(root).length + 1).replaceAll('\\', '/') : '' });
}

for (const [root, file, accept] of tree.negotiation) {
  const picked = mod.selectPrecompressed(join(rootOf(root), file), accept);
  out.negotiation.push({ root, file, accept, picked: picked ? { file: picked.path.slice(rootOf(root).length + 1).replaceAll('\\', '/'), encoding: picked.encoding } : null });
}

for (const [header, encoding] of tree.accepted) {
  out.accepted.push({ header, encoding, accepted: mod.encodingAccepted(header, encoding) });
}

for (const [token, device] of tree.cookies) {
  out.cookies.push({
    token,
    device,
    pairing: mod.pairingCookieHeaders(token, { socket: { encrypted: false } }),
    pairingSecure: mod.pairingCookieHeaders(token, { socket: { encrypted: true } }),
    device_: mod.deviceCookieHeaders(device, { socket: { encrypted: false } }),
    deviceSecure: mod.deviceCookieHeaders(device, { socket: { encrypted: true } }),
    merged: mod.mergeCookieHeaders(
      mod.pairingCookieHeaders(token, { socket: { encrypted: false } }),
      mod.deviceCookieHeaders(device, { socket: { encrypted: true } })
    ),
  });
}

for (const header of tree.cookieHeaders) {
  out.credentials.push({ header, token: mod.parseCookieToken(header), device: mod.parseCookieDevice(header) });
}
for (const headers of tree.credentialHeaders) {
  out.credentials.push({ headers, allowed: mod.cookieCredentialAllowed(headers) });
}

writeFileSync(output, `${JSON.stringify(out, null, 1)}\n`);
