/**
 * What the network proxy setting does right now: the route it gives a
 * destination (for the Settings row's description) and a connection check
 * through it. Both go through the same policy the provider paths use.
 */
import { getLlmDispatcher, osProxyRoute, routeForUrl } from './http-agent.mjs';
import { proxyDisplay, proxyVariablesSet, ProxyConfigError } from './proxy-policy.mjs';

/** Where the check goes when the main route has no endpoint of its own. */
export const DEFAULT_CHECK_ORIGIN = 'https://api.openai.com';
const CHECK_TIMEOUT_MS = 10_000;

const FIRST_PARTY_ORIGINS = [
  [/^anthropic/, 'https://api.anthropic.com'],
  [/^openai/, 'https://api.openai.com'],
  [/^gemini/, 'https://generativelanguage.googleapis.com'],
  [/^grok|^xai/, 'https://api.x.ai'],
  [/^cursor/, 'https://api2.cursor.sh'],
];

/**
 * The origin to check for the main route's `provider`: its configured
 * `baseURL`, else the preset's, else its vendor's API; api.openai.com when
 * there is no provider. `presets` maps a provider id to `{ baseURL }`.
 */
export function providerCheckOrigin(provider, providers = {}, presets = {}) {
  const name = typeof provider === 'string' ? provider : '';
  const configured = providers?.[name]?.baseURL ?? presets?.[name]?.baseURL;
  const vendor = FIRST_PARTY_ORIGINS.find(([pattern]) => pattern.test(name))?.[1];
  try {
    return new URL(configured || vendor || DEFAULT_CHECK_ORIGIN).origin;
  } catch {
    return DEFAULT_CHECK_ORIGIN;
  }
}

const PLATFORM_NAMES = { win32: 'windows', darwin: 'macos' };

/**
 * The effective route of `origin` under `setting`, as facts for the UI:
 * `{ via, proxy, envVar, ignored: { system, env }, noProxyAll, platform, error }`.
 * `via` is off, manual, env, system or direct; `proxy` is `host:port` without
 * credentials. Under `off`, `ignored` names what exists and is not followed.
 */
export async function explainProxyRoute(origin, setting) {
  const env = process.env;
  const facts = {
    via: 'direct',
    proxy: null,
    envVar: null,
    ignored: { system: false, env: [] },
    noProxyAll: setting.mode === 'system' && (env.NO_PROXY ?? env.no_proxy ?? '').trim() === '*',
    platform: PLATFORM_NAMES[process.platform] ?? 'other',
    error: null,
  };
  try {
    const route = await routeForUrl(origin, setting);
    facts.via = route.via;
    facts.proxy = route.proxy ? proxyDisplay(route.proxy) : null;
    facts.envVar = route.envVar ?? null;
  } catch (error) {
    if (!(error instanceof ProxyConfigError)) throw error;
    facts.via = 'manual';
    facts.error = 'no-address';
  }
  if (setting.mode === 'off') {
    facts.ignored.env = proxyVariablesSet(env);
    facts.ignored.system = Boolean((await osProxyRoute(origin)).proxy);
  }
  return facts;
}

/** The first error code in a fetch failure's cause chain, such as ECONNREFUSED. */
function failureCode(error) {
  for (let cause = error; cause; cause = cause.cause) {
    if (typeof cause.code === 'string') return cause.code;
  }
  return error?.name === 'TimeoutError' ? 'ETIMEDOUT' : 'UNKNOWN';
}

/**
 * Connect to `origin` through the current policy: any HTTP answer, whatever
 * its status, shows the route works. `{ ok, ms, origin, status }`, or
 * `{ ok: false, ms, origin, code }` — the failure is the proxy's or the
 * network's, never retried directly.
 */
export async function checkProxyConnection(origin, setting) {
  getLlmDispatcher();
  const route = await explainProxyRoute(origin, setting);
  const started = performance.now();
  try {
    const response = await fetch(origin, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
    await response.body?.cancel();
    return { ok: true, ms: Math.round(performance.now() - started), origin, status: response.status, route };
  } catch (error) {
    return { ok: false, ms: Math.round(performance.now() - started), origin, code: failureCode(error), route };
  }
}
