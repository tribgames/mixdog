/**
 * Raw-socket paths under the network proxy policy. fetch follows the policy
 * through the global dispatcher (http-agent.mjs); the OpenAI WebSocket and
 * Cursor's HTTP/2 open their own sockets, so they ask the same decision
 * (routeForUrl) and, when it names a proxy, tunnel through it with HTTP
 * CONNECT (http, https proxies) or SOCKS5 using undici's own clients — no
 * second proxy stack. A proxy that cannot be reached or refuses the tunnel is
 * an error; there is no direct fallback.
 */
import { createRequire } from 'node:module';
import http2 from 'node:http2';
import tls from 'node:tls';
import { routeForUrl } from './http-agent.mjs';
import { proxyDisplay } from './proxy-policy.mjs';

const require = createRequire(import.meta.url);
/** How long a proxy may take to answer a CONNECT. */
const TUNNEL_TIMEOUT_MS = 30_000;

/** proxy URL → its Socks5ProxyAgent (stateless per tunnel, so one serves all). */
const socksAgents = new Map();

function socksAgent(proxyUrl) {
  let agent = socksAgents.get(proxyUrl);
  if (!agent) {
    agent = new (require('undici').Socks5ProxyAgent)(proxyUrl);
    socksAgents.set(proxyUrl, agent);
  }
  return agent;
}
function noop() {}

/**
 * A socket tunneled through `proxyUrl` to `host:port` (the proxy resolves
 * `host`). Rejects when the proxy cannot be reached or does not agree to the
 * tunnel. `signal` ends a CONNECT still in flight (undici closes its socket);
 * a SOCKS5 handshake cannot be interrupted, so a tunnel that arrives after the
 * abort is destroyed here and the call rejects.
 */
export async function openProxyTunnel(proxyUrl, host, port, { signal } = {}) {
  // Cancelled before it began: nothing is sent, and an abort event that already fired is never missed below.
  signal?.throwIfAborted();
  if (proxyUrl.startsWith('socks5:')) {
    const socket = await socksAgent(proxyUrl).createSocks5Connection(host, port);
    if (!signal?.aborted) return socket;
    socket.on('error', noop).destroy();
    throw signal.reason;
  }
  const authority = `${host.includes(':') ? `[${host}]` : host}:${port}`;
  const headers = { host: authority };
  const { username, password } = new URL(proxyUrl);
  if (username) {
    const credentials = `${decodeURIComponent(username)}:${decodeURIComponent(password)}`;
    headers['proxy-authorization'] = `Basic ${Buffer.from(credentials).toString('base64')}`;
  }
  // One client per tunnel: a CONNECT takes its connection for good, and aborting
  // destroys the client, which closes the socket to the proxy at once.
  const client = new (require('undici').Client)(new URL(proxyUrl).origin, { headersTimeout: TUNNEL_TIMEOUT_MS });
  const abort = () => client.destroy(signal.reason);
  signal?.addEventListener('abort', abort, { once: true });
  let tunnel;
  try {
    tunnel = await client.connect({ path: authority, headers });
  } finally {
    signal?.removeEventListener('abort', abort);
    client.close().catch(noop);
  }
  const { socket, statusCode } = tunnel;
  if (signal?.aborted) {
    socket.on('error', noop).destroy();
    throw signal.reason;
  }
  if (statusCode !== 200) {
    socket.on('error', noop).destroy();
    throw Object.assign(
      new Error(`The proxy ${proxyDisplay(proxyUrl)} refused the tunnel to ${authority} (HTTP ${statusCode})`),
      { code: 'EPROXY', status: statusCode }
    );
  }
  return socket;
}

function defaultPort(url) {
  return Number(url.port) || (url.protocol === 'https:' || url.protocol === 'wss:' ? 443 : 80);
}

/**
 * The policy's tunnel for `target` (an http(s) or ws(s) URL): a socket to the
 * target through its proxy, or null when it connects directly. May throw
 * (a manual proxy without an address) or reject (the proxy failed).
 */
export async function openTunnelFor(target, { signal } = {}) {
  signal?.throwIfAborted();
  const route = await routeForUrl(target);
  // The route lookup may have outlived the caller.
  signal?.throwIfAborted();
  if (!route.proxy) return null;
  const url = new URL(target);
  return openProxyTunnel(route.proxy, url.hostname.replace(/^\[(.*)\]$/, '$1'), defaultPort(url), { signal });
}

/**
 * An HTTP/2 client session to `url` (`https://host[:port]`) that follows the
 * policy: straight when the route is direct, otherwise over a TLS connection
 * negotiated end to end inside the proxy's tunnel.
 */
export async function connectHttp2Session(url, options, { signal } = {}) {
  const target = new URL(url);
  const tunnel = await openTunnelFor(target.origin, { signal });
  if (!tunnel) {
    signal?.throwIfAborted();
    return http2.connect(url, options);
  }
  let socket = tunnel;
  try {
    signal?.throwIfAborted();
    if (target.protocol === 'https:') {
      socket = tls.connect({
        socket: tunnel,
        ALPNProtocols: ['h2'],
        servername: target.hostname.replace(/^\[(.*)\]$/, '$1'),
      });
    }
    return http2.connect(url, { ...options, createConnection: () => socket });
  } catch (error) {
    socket.destroy();
    throw error;
  }
}
