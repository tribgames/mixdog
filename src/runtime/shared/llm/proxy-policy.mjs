/**
 * The network proxy policy: the one decision every outbound provider path
 * (fetch, WebSocket, HTTP/2) asks for the destination it is about to open.
 *
 * The setting lives in the agent config as `networkProxy`
 * `{ mode, url, exceptions }` and is read from the config file on every
 * decision (a stat-validated cache), so a change made in any process applies
 * to the next connection of every other one.
 *
 *   system  the user's proxy variables (HTTPS_PROXY / HTTP_PROXY / ALL_PROXY,
 *           NO_PROXY; `NO_PROXY=*` forces direct), otherwise the OS proxy
 *           (system-proxy.mjs). Local and LAN hosts are always direct.
 *   manual  `url` for everything except `exceptions`. No other bypass, and a
 *           proxy that fails is a failure: there is no direct fallback.
 *   off     direct, ignoring the OS proxy and every proxy variable.
 *
 * This module is a leaf: it holds the setting model and the pure decision.
 * http-agent.mjs supplies the OS route and the local-host test.
 */
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { BlockList, isIP } from 'node:net';
import { join } from 'node:path';
import { isPlainObject } from '../object.mjs';
import { resolvePluginData } from '../plugin-paths.mjs';
import { createWatchedFileCache } from '../watched-file-cache.mjs';

export const NETWORK_PROXY_MODES = Object.freeze(['system', 'manual', 'off']);
/** Starting exceptions of a manual proxy, so local providers keep working. */
export const DEFAULT_PROXY_EXCEPTIONS = 'localhost, 127.0.0.1, ::1';
/** Schemes undici's ProxyAgent can tunnel (http, https, socks5) on every path. */
export const PROXY_SCHEMES = Object.freeze(['http:', 'https:', 'socks5:']);

const MAX_URL_LENGTH = 2048;
const MAX_EXCEPTIONS_LENGTH = 4096;

/**
 * `text` as a canonical proxy URL: `{ url }`, or `{ error }`. The scheme is
 * required (`http://proxy.corp:8080`); path, query and fragment are not part
 * of a proxy address; credentials must decode, and are refused unless
 * `credentials` (the stored setting never holds a password).
 */
export function parseProxyUrl(text, schemes = PROXY_SCHEMES, credentials = true) {
  const value = typeof text === 'string' ? text.trim() : '';
  if (!value || value.length > MAX_URL_LENGTH || /\s/.test(value)) return { error: 'is not a proxy address' };
  let url;
  try {
    url = new URL(value);
    decodeURIComponent(url.username);
    decodeURIComponent(url.password);
  } catch {
    return { error: 'is not a proxy address' };
  }
  if (!schemes.includes(url.protocol)) {
    return { error: `must start with ${schemes.map((scheme) => `${scheme}//`).join(', ')}` };
  }
  if (!url.hostname || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
    return { error: 'must be a scheme, host and optional port only' };
  }
  if (!credentials && (url.username || url.password)) return { error: 'must not contain a user name or password' };
  const auth = url.username ? `${url.username}${url.password ? `:${url.password}` : ''}@` : '';
  return { url: `${url.protocol}//${auth}${url.host}` };
}

/** `host:port` of a proxy URL for display: no credentials, and the scheme only when it is not http. */
export function proxyDisplay(proxyUrl) {
  try {
    const { protocol, host } = new URL(proxyUrl);
    return protocol === 'http:' ? host : `${protocol}//${host}`;
  } catch {
    return '';
  }
}

const HOST_PATTERN = /^(\*?\.)?([a-z0-9_-]+(?:\.[a-z0-9_-]+)*)(?::(\d{1,5}))?$/;

/**
 * One NO_PROXY / exception entry as a matcher, or null when it is none.
 * `*` (everything), a host (itself and its subdomains), `.host` / `*.host`
 * (subdomains only), an IP, `ip/prefix` or `ipv4-ipv4`, each with an optional
 * `:port` (IPv6 with a port in brackets).
 */
function parseEntry(raw) {
  const entry = raw.toLowerCase();
  if (entry === '*') return { any: true };
  const bracket = /^\[([0-9a-f:.]+)\](?::(\d{1,5}))?$/.exec(entry);
  const bare = bracket ? bracket[1] : entry;
  if (isIP(bare) === 6) return { ip: bare, family: 'ipv6', port: bracket?.[2] ? Number(bracket[2]) : null };
  const cidr = /^([0-9a-f:.]+)\/(\d{1,3})$/.exec(entry);
  if (cidr && isIP(cidr[1])) {
    const family = isIP(cidr[1]) === 4 ? 'ipv4' : 'ipv6';
    return blockList(family, (list) => list.addSubnet(cidr[1], Number(cidr[2]), family));
  }
  const range = /^(\d{1,3}(?:\.\d{1,3}){3})-(\d{1,3}(?:\.\d{1,3}){3})$/.exec(entry);
  if (range && isIP(range[1]) === 4 && isIP(range[2]) === 4) {
    return blockList('ipv4', (list) => list.addRange(range[1], range[2], 'ipv4'));
  }
  const host = HOST_PATTERN.exec(entry);
  if (!host) return null;
  const port = host[3] === undefined ? null : Number(host[3]);
  if (port !== null && port > 65535) return null;
  if (isIP(host[2]) === 4) return { ip: host[2], family: 'ipv4', port };
  return { host: host[2], subdomainsOnly: host[1] !== undefined, port };
}

/**
 * A subnet or range matcher, built once here: null when BlockList refuses it
 * (a prefix out of range, a reversed range), so no stored text can make a
 * routing decision throw.
 */
function blockList(family, fill) {
  const list = new BlockList();
  try {
    fill(list);
  } catch {
    return null;
  }
  return { list, family, port: null };
}

function entryMatches(entry, hostname, port, family) {
  if (entry.any) return true;
  if (entry.port != null && entry.port !== port) return false;
  if (entry.host !== undefined) {
    return (!entry.subdomainsOnly && hostname === entry.host) || hostname.endsWith(`.${entry.host}`);
  }
  const wanted = family === 4 ? 'ipv4' : family === 6 ? 'ipv6' : null;
  if (wanted !== entry.family) return false;
  if (entry.ip !== undefined) return hostname === entry.ip || canonicalHost(hostname) === canonicalHost(entry.ip);
  return entry.list.check(hostname, entry.family);
}

function canonicalHost(address) {
  try {
    return new URL(`http://${isIP(address) === 6 ? `[${address}]` : address}`).hostname.replace(/^\[(.*)\]$/, '$1');
  } catch {
    return address;
  }
}

// The parsed list of the last texts asked: a decision parses nothing new.
const parsedLists = new Map();

/** The matchers of the valid entries of 	ext; invalid ones match nothing. */
function parseList(text) {
  let entries = parsedLists.get(text);
  if (!entries) {
    entries = splitEntries(text)
      .map(parseEntry)
      .filter((entry) => entry !== null);
    if (parsedLists.size >= 32) parsedLists.clear();
    parsedLists.set(text, entries);
  }
  return entries;
}

function splitEntries(text) {
  return String(text ?? '')
    .split(/[\s,;]+/)
    .filter(Boolean);
}

/** Why `text` is not a list of exceptions (comma separated), or null. */
export function exceptionsError(text) {
  if (typeof text !== 'string') return 'must be a string';
  if (text.length > MAX_EXCEPTIONS_LENGTH) return 'is too long';
  const bad = splitEntries(text).find((entry) => !parseEntry(entry));
  return bad === undefined ? null : `has an entry that is not an address: ${bad.slice(0, 64)}`;
}

/** `text` as the stored list: entries trimmed, deduplicated, `, `-separated. */
export function canonicalExceptions(text) {
  return [...new Set(splitEntries(text).map((entry) => entry.toLowerCase()))].join(', ');
}

/** True when `url`'s host (and port) is covered by the list `text`; unparsable entries match nothing. */
export function exceptionsCover(text, url) {
  const hostname = url.hostname.replace(/^\[(.*)\]$/, '$1').replace(/\.$/, '').toLowerCase();
  const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
  const family = isIP(hostname);
  return parseList(String(text ?? '')).some((entry) => entryMatches(entry, hostname, port, family));
}

/**
 * The effective setting from the stored value. An invalid stored field reads
 * as its default, so a hand edit never breaks boot.
 * @returns {{ mode: 'system'|'manual'|'off', url: string, exceptions: string }}
 */
export function normalizeNetworkProxy(stored) {
  const source = isPlainObject(stored) ? stored : {};
  const parsed = typeof source.url === 'string' ? parseProxyUrl(source.url, PROXY_SCHEMES, false) : {};
  return {
    mode: NETWORK_PROXY_MODES.includes(source.mode) ? source.mode : 'system',
    url: parsed.url ?? '',
    exceptions:
      typeof source.exceptions === 'string' && exceptionsError(source.exceptions) === null
        ? canonicalExceptions(source.exceptions)
        : DEFAULT_PROXY_EXCEPTIONS,
  };
}

const PATCH_KEYS = ['mode', 'url', 'exceptions'];

/**
 * Apply a user patch strictly: an unknown key, an invalid value, or a manual
 * proxy without an address throws and nothing is stored.
 * @returns {{ mode: string, url: string, exceptions: string }}
 */
export function applyNetworkProxyPatch(current, patch) {
  if (!isPlainObject(patch) || !Object.keys(patch).length) {
    throw new TypeError('networkProxy requires at least one of mode, url, exceptions.');
  }
  const next = { ...normalizeNetworkProxy(current) };
  for (const [key, value] of Object.entries(patch)) {
    if (!PATCH_KEYS.includes(key)) throw new TypeError(`networkProxy.${key} is not a network proxy setting.`);
    if (key === 'mode') {
      if (!NETWORK_PROXY_MODES.includes(value)) {
        throw new TypeError(`networkProxy.mode must be one of ${NETWORK_PROXY_MODES.join(', ')}.`);
      }
      next.mode = value;
    } else if (key === 'url') {
      // '' forgets the address; manual mode then has none, which is refused below.
      const parsed = value === '' ? { url: '' } : parseProxyUrl(value, PROXY_SCHEMES, false);
      if (parsed.error) throw new TypeError(`networkProxy.url ${parsed.error}.`);
      next.url = parsed.url;
    } else {
      const error = exceptionsError(value);
      if (error) throw new TypeError(`networkProxy.exceptions ${error}.`);
      next.exceptions = canonicalExceptions(value);
    }
  }
  if (next.mode === 'manual' && !next.url) {
    throw new TypeError('networkProxy.url is required when mode is manual.');
  }
  return next;
}

/** A manual proxy that has no usable address: every connection fails with this, never goes direct. */
export class ProxyConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProxyConfigError';
    this.code = 'MIXDOG_PROXY_CONFIG';
  }
}

const DEFAULT_SETTING = Object.freeze(normalizeNetworkProxy(null));
const CONFIG_FILE = 'mixdog-config.json';

/** The setting in a config file's text; a config with no `networkProxy` key means the default. */
function settingOf(text) {
  const root = JSON.parse(text.replace(/^\uFEFF/, ''));
  return Object.freeze(normalizeNetworkProxy(root?.agent?.networkProxy));
}

// The setting is held in memory and replaced by the config file's watch
// event, whoever wrote the file (watched-file-cache.mjs): a routing decision
// touches no file. A file that cannot be read or parsed keeps the last
// valid setting; one that vanished after a value was read is such a failure
// too, since only a config without the key means `system`.
const settings = createWatchedFileCache({
  load(path) {
    try {
      return { value: settingOf(readFileSync(path, 'utf8')) };
    } catch (error) {
      if (error?.code === 'ENOENT' && settings.peek(path) === undefined) return { value: DEFAULT_SETTING };
      throw error;
    }
  },
  async loadAsync(path) {
    try {
      return { value: settingOf(await readFile(path, 'utf8')) };
    } catch (error) {
      if (error?.code === 'ENOENT' && settings.peek(path) === undefined) return { value: DEFAULT_SETTING };
      throw error;
    }
  },
});

const configPath = () => join(resolvePluginData(), CONFIG_FILE);

/**
 * The network proxy setting now. Memory only once warm; the first read of a
 * config file is the only synchronous one. Throws ProxyConfigError when the
 * config has never been readable: no setting is known, so nothing may go out.
 */
export function currentProxySetting() {
  try {
    return settings.get(configPath());
  } catch {
    throw new ProxyConfigError('The network proxy setting cannot be read from the config file.');
  }
}

/** This process stored `setting` in the config file: later decisions use it now, without waiting for the watch event. */
export function adoptProxySetting(setting) {
  settings.set(configPath(), Object.freeze(normalizeNetworkProxy(setting)));
}

/** Test seam: forget every held setting and close the watches. */
export function _resetProxySettingForTest() {
  settings.clear();
}
/** The proxy variables, in the order Codex resolves them for a request kind. */
const ENV_PROXY_VARS = {
  http: ['HTTP_PROXY', 'ALL_PROXY'],
  https: ['HTTPS_PROXY', 'ALL_PROXY'],
  wss: ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY'],
};

function envValue(env, name) {
  const value = env[name] ?? env[name.toLowerCase()];
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

/** The proxy variable that applies to a request kind: `{ name, url }` or null. ALL_PROXY must be http(s). */
export function envProxyFor(kind, env) {
  for (const name of ENV_PROXY_VARS[kind]) {
    const parsed = parseProxyUrl(envValue(env, name), name === 'ALL_PROXY' ? ['http:', 'https:'] : PROXY_SCHEMES);
    if (parsed.url) return { name, url: parsed.url };
  }
  return null;
}

/** The names of the proxy variables set in `env`, for describing what `off` ignores. */
export function proxyVariablesSet(env) {
  return ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY'].filter((name) => envValue(env, name));
}

const DIRECT = (via) => ({ proxy: null, via });

/** `target` as an http(s) URL plus its request kind (ws and wss follow their http equivalents). */
function requestOf(target) {
  const url = new URL(target);
  const kind = { 'https:': 'https', 'wss:': 'wss', 'http:': 'http', 'ws:': 'http' }[url.protocol];
  if (!kind) return null;
  if (url.protocol === 'ws:' || url.protocol === 'wss:') url.protocol = kind === 'wss' ? 'https:' : 'http:';
  return { url, kind };
}

/**
 * The route for `target`: `{ proxy, via }` — `proxy` a proxy URL or null for
 * direct, `via` one of off, manual, env, system, direct — or a promise of one
 * while the OS route is looked up. Throws ProxyConfigError for a manual proxy
 * without an address.
 *
 * @param {string|URL} target
 * @param {object} context
 * @param {{ mode: string, url: string, exceptions: string }} context.setting
 * @param {Record<string, string|undefined>} context.env
 * @param {((origin: string) => { proxy: string|null } | Promise<{ proxy: string|null }>) | null} context.system the OS route, when this process has one
 * @param {(hostname: string) => boolean} context.isLocalHost
 */
export function decideProxyRoute(target, { setting, env, system, isLocalHost }) {
  if (setting.mode === 'off') return DIRECT('off');
  const request = requestOf(target);
  if (!request) return DIRECT('direct');
  const { url, kind } = request;
  if (setting.mode === 'manual') {
    if (!setting.url) throw new ProxyConfigError('The network proxy is set to manual but has no address.');
    return exceptionsCover(setting.exceptions, url) ? DIRECT('direct') : { proxy: setting.url, via: 'manual' };
  }
  const noProxy = envValue(env, 'NO_PROXY');
  if (noProxy === '*') return DIRECT('direct');
  if (isLocalHost(url.hostname)) return DIRECT('direct');
  const fromEnv = envProxyFor(kind, env);
  if (fromEnv) {
    return exceptionsCover(noProxy, url) ? DIRECT('direct') : { proxy: fromEnv.url, via: 'env', envVar: fromEnv.name };
  }
  if (!system) return DIRECT('direct');
  const answer = system(url.origin);
  const route = ({ proxy }) => (proxy ? { proxy, via: 'system' } : DIRECT('direct'));
  return typeof answer?.then === 'function' ? answer.then(route) : route(answer);
}
