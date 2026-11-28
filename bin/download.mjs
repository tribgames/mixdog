// The download of a runtime archive (bin/runtime.mjs). Dependency-free: the launcher ships alone.
//
// Route: an https URL goes through the first proxy set of npm's `https-proxy`, the HTTPS_PROXY, https_proxy, HTTP_PROXY
// and http_proxy variables, and npm's `proxy` (npm's own order; npm hands its settings to the scripts it runs as
// npm_config_*), tunnelled with CONNECT; a host NO_PROXY names (npm's `noproxy`, NO_PROXY, no_proxy) is reached
// directly. Trust: Node's default certificates (NODE_EXTRA_CA_CERTS included), and npm's `cafile` and `ca` added to them
// when set. No credential is ever sent: there is no Authorization header, and the user of a proxy URL goes to that
// proxy only. The bytes are not trusted for being downloaded: the caller verifies them against the manifest.
import { createWriteStream, readFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { pipeline } from 'node:stream/promises';
import tls from 'node:tls';

const MAX_REDIRECTS = 10;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

const setting = (env, names) => names.map((name) => env[name]).find((value) => typeof value === 'string' && value.trim() !== '');

/** The proxy for `url` under `env`, or null for a direct connection. */
export function proxyFor(url, env = process.env) {
  const target = new URL(url);
  const names =
    target.protocol === 'https:'
      ? ['npm_config_https_proxy', 'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'npm_config_proxy']
      : ['npm_config_proxy', 'HTTP_PROXY', 'http_proxy'];
  const value = setting(env, names);
  if (!value || bypassesProxy(target, setting(env, ['npm_config_noproxy', 'NO_PROXY', 'no_proxy']) ?? '')) return null;
  const proxy = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value.trim()) ? value.trim() : `http://${value.trim()}`);
  if (proxy.protocol !== 'http:' && proxy.protocol !== 'https:')
    throw new Error(`the proxy ${proxy.origin} is not an http or https proxy`);
  return proxy;
}

const defaultPort = (url) => Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
const bareHost = (url) => url.hostname.replace(/^\[(.*)\]$/, '$1').toLowerCase();

/** Whether a NO_PROXY list names the host of `url`: `*`, the host itself or a domain it is in, with the port when one is given. */
export function bypassesProxy(url, list) {
  const host = bareHost(url);
  const port = defaultPort(url);
  return list
    .split(/[\s,]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
    .some((entry) => {
      if (entry === '*') return true;
      const match = /^(.*?)(?::(\d+))?$/.exec(entry.replace(/^\[(.*)\](:\d+)?$/, '$1$2'));
      const name = match[1].replace(/^\*?\.?/, '');
      if (match[2] && Number(match[2]) !== port) return false;
      return host === name || host.endsWith(`.${name}`);
    });
}

const DELIMITER = '-----END CERTIFICATE-----';
const certificatesOf = (text) =>
  text
    .replace(/\r\n/g, '\n')
    .split(DELIMITER)
    .filter((section) => section.trim())
    .map((section) => `${section.trimStart()}${DELIMITER}`);

/** The certificates to trust when npm names its own (`cafile`, `ca`), added to Node's; undefined for Node's alone. */
export function trustedCertificates(env = process.env, read = (file) => readFileSync(file, 'utf8')) {
  const extra = [];
  if (setting(env, ['npm_config_cafile'])) extra.push(...certificatesOf(read(env.npm_config_cafile.trim())));
  if (setting(env, ['npm_config_ca'])) extra.push(...certificatesOf(env.npm_config_ca));
  return extra.length > 0 ? [...tls.getCACertificates('default'), ...extra] : undefined;
}

/** `socket` once it emits `event`; destroyed and rejected on an error or when nothing happens for `timeoutMs`. */
function settle(socket, event, timeoutMs, what) {
  return new Promise((resolve, reject) => {
    const onTimeout = () => fail(new Error(`${what} timed out after ${Math.round(timeoutMs / 1000)} s`));
    const fail = (error) => {
      socket.off('timeout', onTimeout);
      socket.destroy();
      reject(error);
    };
    socket.setTimeout(timeoutMs);
    socket.on('timeout', onTimeout);
    socket.once('error', fail);
    socket.once(event, () => {
      socket.off('error', fail);
      socket.off('timeout', onTimeout);
      socket.setTimeout(0);
      resolve(socket);
    });
  });
}

const tlsTo = (host, options) => ({ ...options, servername: net.isIP(host) ? undefined : host, ALPNProtocols: ['http/1.1'] });

/** A CONNECT tunnel to `host:port` through `proxy`. */
async function tunnel(proxy, host, port, { ca, timeoutMs }) {
  const proxyHost = bareHost(proxy);
  const socket =
    proxy.protocol === 'https:'
      ? await settle(tls.connect(tlsTo(proxyHost, { host: proxyHost, port: defaultPort(proxy), ca })), 'secureConnect', timeoutMs, `connecting to the proxy ${proxy.host}`)
      : await settle(net.connect({ host: proxyHost, port: defaultPort(proxy) }), 'connect', timeoutMs, `connecting to the proxy ${proxy.host}`);
  const authority = net.isIPv6(host) ? `[${host}]:${port}` : `${host}:${port}`;
  const user = proxy.username ? `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}` : '';
  const auth = user ? `Proxy-Authorization: Basic ${Buffer.from(user).toString('base64')}\r\n` : '';
  socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${auth}\r\n`);
  // The origin speaks only after this side does, so the answer is the whole of what arrives first.
  const { head, rest } = await new Promise((resolve, reject) => {
    let received = Buffer.alloc(0);
    const done = (settled) => {
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('end', onEnd);
      socket.off('timeout', onTimeout);
      socket.setTimeout(0);
      settled();
    };
    const onData = (chunk) => {
      received = Buffer.concat([received, chunk]);
      const end = received.indexOf('\r\n\r\n');
      if (end !== -1) done(() => resolve({ head: received.subarray(0, end).toString('latin1'), rest: received.length - end - 4 }));
    };
    const onError = (error) => done(() => reject(error));
    const onEnd = () => done(() => reject(new Error(`the proxy ${proxy.host} closed the connection before it answered CONNECT`)));
    const onTimeout = () =>
      done(() => {
        socket.destroy();
        reject(new Error(`the proxy ${proxy.host} did not answer CONNECT in ${Math.round(timeoutMs / 1000)} s`));
      });
    socket.setTimeout(timeoutMs);
    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('end', onEnd);
    socket.on('timeout', onTimeout);
  });
  const status = /^HTTP\/1\.[01] (\d{3})/.exec(head)?.[1];
  if (status !== '200' || rest !== 0) {
    socket.destroy();
    throw new Error(`the proxy ${proxy.host} refused the tunnel to ${authority}: ${head.split('\r\n')[0]}`);
  }
  return socket;
}

/** A connection to the origin of `url`, through its proxy when it has one, with TLS for https; `close` ends every socket of it. */
async function connect(url, { env, ca, timeoutMs }) {
  const host = bareHost(url);
  const port = defaultPort(url);
  const proxy = proxyFor(url, env);
  const raw = proxy
    ? await tunnel(proxy, host, port, { ca, timeoutMs })
    : url.protocol === 'https:'
      ? null
      : await settle(net.connect({ host, port }), 'connect', timeoutMs, `connecting to ${url.host}`);
  const close = (socket) => () => {
    socket.destroy();
    raw?.destroy();
  };
  if (url.protocol !== 'https:') return { socket: raw, close: close(raw) };
  const options = raw ? { socket: raw } : { host, port };
  try {
    const socket = await settle(tls.connect(tlsTo(host, { ...options, ca })), 'secureConnect', timeoutMs, `connecting to ${url.host}`);
    return { socket, close: close(socket) };
  } catch (error) {
    raw?.destroy();
    throw error;
  }
}

/** One GET of `url` on a connection of its own: the response, unread, and `close`, which ends the connection. */
async function get(url, { env, ca, timeoutMs, userAgent }) {
  const { socket, close } = await connect(url, { env, ca, timeoutMs });
  socket.setTimeout(timeoutMs, () => socket.destroy(new Error(`${url.host} sent nothing for ${Math.round(timeoutMs / 1000)} s`)));
  try {
    const response = await new Promise((resolve, reject) => {
      const request = http.request({
        host: bareHost(url),
        port: defaultPort(url),
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers: { host: url.host, 'user-agent': userAgent, accept: 'application/octet-stream' },
        createConnection: () => socket,
      });
      request.once('response', resolve);
      request.once('error', reject);
      request.end();
    });
    return { response, close };
  } catch (error) {
    close();
    throw error;
  }
}

/** `url` without its query, which for a signed download link is a credential. */
const shown = (url) => `${url.origin}${url.pathname}`;

/**
 * Writes the body at `url` (following redirects, never from https to http) to `file`, refusing a body that is not exactly
 * `length` bytes. `onProgress(bytes)` is called as it arrives.
 */
export async function download({ url, file, length, env = process.env, timeoutMs = 60_000, userAgent = 'mixdog-runtime', onProgress = () => {} }) {
  const ca = trustedCertificates(env);
  let current = new URL(url);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const { response, close } = await get(current, { env, ca, timeoutMs, userAgent });
    try {
      const status = response.statusCode;
      if (REDIRECTS.has(status) && response.headers.location) {
        const next = new URL(response.headers.location, current);
        if (current.protocol === 'https:' && next.protocol !== 'https:') throw new Error(`${shown(current)} redirects to ${next.protocol} ${next.host}, which is not https`);
        current = next;
        continue;
      }
      if (status !== 200) throw new Error(`${shown(current)} answered HTTP ${status}`);
      const declared = response.headers['content-length'];
      if (declared !== undefined && Number(declared) !== length) throw new Error(`${shown(current)} is ${declared} bytes, not the ${length} bytes of the release asset`);
      let received = 0;
      await pipeline(
        response,
        async function* count(source) {
          for await (const chunk of source) {
            received += chunk.length;
            if (received > length) throw new Error(`${shown(current)} sent more than the ${length} bytes of the release asset`);
            onProgress(received);
            yield chunk;
          }
          if (received !== length) throw new Error(`${shown(current)} ended after ${received} of ${length} bytes`);
        },
        createWriteStream(file)
      );
      return;
    } finally {
      close();
    }
  }
  throw new Error(`${url} redirects more than ${MAX_REDIRECTS} times`);
}