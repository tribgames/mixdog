/**
 * The OS static proxy (the one Clash or Windows Settings writes) for Mixdog's
 * own network stack, which Node does not make follow it by itself.
 *
 * A proxy that came from the OS is Mixdog's private state, never environment:
 * no HTTPS_PROXY / HTTP_PROXY / NO_PROXY / NODE_USE_ENV_PROXY is written, so the
 * shells, tools and CLIs Mixdog spawns do not inherit it. It is applied to the
 * global fetch dispatcher (http-agent.mjs adoptPrivateProxy) together with its
 * exact bypass rules, and reaches Mixdog's own daemon and workers through one
 * explicit handoff variable that the receiver reads and removes at startup.
 * Proxy variables the user set keep their usual behaviour and win outright.
 *
 * Windows discovery reads the registry once at startup. The proxy is used only
 * when the registry answer is exactly representable: a PAC script
 * (AutoConfigURL), SOCKS-only entries and exceptions that have no exact rule
 * leave routing untouched. "Automatically detect settings" (WPAD) is on by
 * default in Windows and is not consulted: an enabled static proxy is used.
 * Any read failure means no system proxy.
 */

import { execFileSync } from 'node:child_process';
import { isIP } from 'node:net';
import { join } from 'node:path';
import { adoptPrivateProxy, isLocalHost } from './http-agent.mjs';

const INTERNET_SETTINGS_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
const USER_PROXY_VARS = [
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'ALL_PROXY',
  'all_proxy',
  'NODE_USE_ENV_PROXY',
];
/**
 * The handoff to a Mixdog process this one starts: JSON `{ proxy, bypass }`,
 * `proxy` null for "decided: direct". Consumed (and removed from the env) by
 * adoptSystemProxy, so nothing downstream of that process ever sees it.
 */
export const HANDOFF_VAR = 'MIXDOG_SYSTEM_PROXY_HANDOFF';

/** The decision this process acted on, or null when it made none. */
let active = null;

/** The rows of `reg query <key>` output as a name → data map; null when the query failed. */
function queryRegistryKey(key) {
  try {
    const exe = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');
    const out = execFileSync(exe, ['query', key], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
      maxBuffer: 256 * 1024,
      windowsHide: true,
    });
    const values = new Map();
    for (const row of out.split(/\r?\n/)) {
      // "    Name    REG_TYPE    data" (data is absent for an empty string)
      const match = row.match(/^ {4}(\S.*?) {4}(REG_[A-Z_]+)(?: {4}(.*))?$/);
      if (match) values.set(match[1].toLowerCase(), (match[3] ?? '').trim());
    }
    return values;
  } catch {
    return null;
  }
}

/**
 * Raw registry values: `{ proxyEnable, proxyServer, proxyOverride, autoConfigUrl }`
 * (strings as `reg query` prints them, null when absent), or null when the
 * Internet Settings key cannot be read.
 */
function readWindowsProxyRegistry() {
  const settings = queryRegistryKey(INTERNET_SETTINGS_KEY);
  if (!settings) return null;
  return {
    proxyEnable: settings.get('proxyenable') ?? null,
    proxyServer: settings.get('proxyserver') ?? null,
    proxyOverride: settings.get('proxyoverride') ?? null,
    autoConfigUrl: settings.get('autoconfigurl') ?? null,
  };
}

const PROXY_ADDRESS = /^(https?:\/\/)?((?:[a-z0-9_-]+\.)*[a-z0-9_-]+|\[[0-9a-f:]+\]):(\d{1,5})$/i;

function proxyUrl(address) {
  const match = PROXY_ADDRESS.exec(address.trim());
  if (!match || Number(match[3]) > 65535) return null;
  return `${(match[1] ?? 'http://').toLowerCase()}${match[2]}:${match[3]}`;
}

/**
 * `ProxyServer` is a bare `host:port` (every scheme) or `scheme=host:port;...`.
 * Returns `{ https, http }` proxy URLs, or `{ reason }`. HTTPS is required:
 * Mixdog's traffic is https, and an http-only entry does not say how it goes.
 */
export function parseProxyServer(value) {
  const text = String(value ?? '').trim();
  if (!text) return { reason: 'no proxy server' };
  if (!text.includes('=')) {
    const url = proxyUrl(text);
    return url ? { https: url, http: url } : { reason: 'unsupported proxy server' };
  }
  const entries = new Map();
  for (const part of text.split(';')) {
    if (!part.trim()) continue;
    const eq = part.indexOf('=');
    if (eq <= 0) return { reason: 'unsupported proxy server' };
    entries.set(part.slice(0, eq).trim().toLowerCase(), part.slice(eq + 1).trim());
  }
  const https = entries.has('https') ? proxyUrl(entries.get('https')) : null;
  const http = entries.has('http') ? proxyUrl(entries.get('http')) : null;
  if (entries.has('https') && !https) return { reason: 'unsupported proxy server' };
  if (entries.has('http') && !http) return { reason: 'unsupported proxy server' };
  if (!https) return { reason: 'no HTTPS proxy (HTTP-only, SOCKS-only or other entries)' };
  return { https, ...(http && { http }) };
}

function ipv4Wildcard(entry) {
  const match = /^(\d{1,3}(?:\.\d{1,3}){0,2})\.\*$/.exec(entry);
  if (!match) return null;
  const octets = match[1].split('.').map(Number);
  if (octets.some((octet) => octet > 255)) return null;
  const pad = (fill) => [...octets, ...Array(4 - octets.length).fill(fill)].join('.');
  return { start: pad(0), end: pad(255) };
}

/** The form a URL hostname takes for an IP literal (IPv6 compressed, no brackets). */
function canonicalIp(address, family) {
  return new URL(`http://${family === 6 ? `[${address}]` : address}`).hostname.replace(/^\[(.*)\]$/, '$1');
}

/**
 * `ProxyOverride` as bypass rules `{ hosts, suffixes }` (exact hosts and IP
 * literals; `*.domain` as the bare domain, subdomains only), or null when any
 * entry has no exact rule. `<local>` (dotless names) and IPv4 wildcards inside
 * the loopback / private ranges need no rule: the dispatcher already connects
 * to every local host directly (isLocalHost).
 */
export function translateProxyOverride(value) {
  const hosts = [];
  const suffixes = [];
  for (const raw of String(value ?? '').split(';')) {
    const entry = raw.trim().toLowerCase();
    if (!entry || entry === '<local>') continue;
    const bare = entry.replace(/^\[(.*)\]$/, '$1');
    const family = isIP(bare);
    if (family) {
      hosts.push(canonicalIp(bare, family));
      continue;
    }
    const range = ipv4Wildcard(entry);
    if (range) {
      if (isLocalHost(range.start) && isLocalHost(range.end)) continue;
      return null;
    }
    const wildcard = /^\*\.((?:[a-z0-9_-]+\.)*[a-z0-9_-]+)$/.exec(entry);
    if (wildcard) suffixes.push(wildcard[1]);
    else if (/^(?:[a-z0-9_-]+\.)*[a-z0-9_-]+$/.test(entry) && !/^[\d.]+$/.test(entry)) hosts.push(entry);
    else return null;
  }
  return { hosts, suffixes };
}

/**
 * The decision for registry `values`: `{ proxy, bypass }`, or `{ reason }` when
 * the system proxy must not be used. `silent` marks reasons that are the
 * user's plain "no proxy" rather than a proxy we declined.
 */
export function systemProxyFromRegistry(values) {
  if (!values) return { reason: 'registry unreadable', silent: true };
  if (!/^(0x)?0*1$/i.test((values.proxyEnable ?? '').trim()) || !values.proxyServer) {
    return { reason: 'disabled', silent: true };
  }
  if (values.autoConfigUrl) return { reason: 'a PAC script is configured' };
  const server = parseProxyServer(values.proxyServer);
  if (server.reason) return { reason: server.reason };
  const bypass = translateProxyOverride(values.proxyOverride);
  if (!bypass) return { reason: 'proxy exceptions cannot be translated exactly' };
  return { proxy: { https: server.https, ...(server.http && { http: server.http }) }, bypass };
}

/**
 * `value` when it is an http(s) proxy URL the dispatcher can be built from:
 * parsable, with a host, and credentials that decode (the dispatcher decodes
 * them and throws on a malformed escape). null otherwise.
 */
function usableProxyUrl(value) {
  try {
    const { protocol, hostname, username, password } = new URL(value);
    decodeURIComponent(username);
    decodeURIComponent(password);
    return (protocol === 'http:' || protocol === 'https:') && hostname ? value : null;
  } catch {
    return null;
  }
}

function stringList(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
}

/**
 * A handoff value as a decision `{ proxy, bypass }`; null when there is none;
 * `{ invalid: true }` when it is malformed (any proxy URL that does not fully
 * validate included).
 */
function parseHandoff(text) {
  if (text === undefined) return null;
  try {
    const { proxy, bypass } = JSON.parse(text);
    if (proxy === null) return { proxy: null };
    const https = usableProxyUrl(proxy?.https);
    const http = proxy.http === undefined ? null : usableProxyUrl(proxy.http);
    if (!https || (proxy.http !== undefined && !http)) return { invalid: true };
    return {
      proxy: { https, ...(http && { http }) },
      bypass: { hosts: stringList(bypass?.hosts), suffixes: stringList(bypass?.suffixes) },
    };
  } catch {
    return { invalid: true };
  }
}

function discover(reader, log) {
  let found;
  try {
    found = systemProxyFromRegistry(reader());
  } catch {
    return { proxy: null };
  }
  if (!found.proxy) {
    if (!found.silent) log(`[mixdog] system proxy not used: ${found.reason}`);
    return { proxy: null };
  }
  return found;
}

/**
 * Settle this process's system-proxy decision and apply it to its own fetch.
 * A handoff from the launching Mixdog process (always removed from `env`) is
 * the decision; without one, Windows reads the registry. Nothing happens, and
 * nothing is handed on, when the user set a proxy variable or
 * MIXDOG_SYSTEM_PROXY=0 (which also disables discovery). Returns true when a
 * proxy was applied.
 */
export function adoptSystemProxy(
  env = process.env,
  {
    platform = process.platform,
    reader = readWindowsProxyRegistry,
    log = (line) => process.stderr.write(`${line}\n`),
    apply = adoptPrivateProxy,
  } = {}
) {
  const handoff = parseHandoff(env[HANDOFF_VAR]);
  delete env[HANDOFF_VAR];
  active = null;
  if (env.MIXDOG_SYSTEM_PROXY === '0' || USER_PROXY_VARS.some((name) => env[name] !== undefined)) return false;
  if (handoff?.invalid) {
    log('[mixdog] system proxy not used: invalid handoff');
    active = { proxy: null };
    return false;
  }
  active = handoff ?? (platform === 'win32' ? discover(reader, log) : null);
  if (!active?.proxy) return false;
  try {
    apply(active.proxy, active.bypass);
  } catch {
    // The dispatcher is built before anything is installed, so nothing is half-applied.
    log('[mixdog] system proxy not used: could not be applied');
    active = { proxy: null };
    return false;
  }
  return true;
}

/**
 * npm's own proxy settings for the one Mixdog-owned npm spawn (the self-update
 * install), from the decision this process holds; empty without one. Meant for
 * that spawn's env only, never for the process env. npm's noproxy matches a
 * host and its subdomains.
 */
export function systemProxyNpmEnv() {
  if (!active?.proxy) return {};
  const { hosts, suffixes } = active.bypass;
  const noproxy = ['localhost', '127.0.0.1', '::1', '.local', ...hosts, ...suffixes.map((suffix) => `.${suffix}`)];
  return {
    npm_config_proxy: active.proxy.http ?? active.proxy.https,
    npm_config_https_proxy: active.proxy.https,
    npm_config_noproxy: noproxy.join(','),
  };
}

/** The handoff for a Mixdog process this one starts; empty when no decision was made. */
export function systemProxyHandoffEnv() {
  return active ? { [HANDOFF_VAR]: JSON.stringify(active) } : {};
}
