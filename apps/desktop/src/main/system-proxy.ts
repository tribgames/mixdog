// The OS proxy (WinINET/registry, macOS settings, PAC) for the local daemon.
// Chromium follows it; Node does not, so the daemon would go direct where the
// browser goes through the user's proxy. Its answer is handed to the daemon
// fork in one private variable (src/runtime/shared/llm/system-proxy.mjs
// adoptSystemProxy reads it and removes it from the daemon's env); it is never
// exported as HTTPS_PROXY / HTTP_PROXY / NO_PROXY, which every shell and tool
// the daemon spawns would inherit.

const PROXY_ENV_NAMES = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'];
/** Must match HANDOFF_VAR in src/runtime/shared/llm/system-proxy.mjs. */
export const SYSTEM_PROXY_HANDOFF_VAR = 'MIXDOG_SYSTEM_PROXY_HANDOFF';
/** The host a PAC script is asked about: provider sign-in traffic. */
export const SYSTEM_PROXY_PROBE_URL = 'https://auth.openai.com';
const RESOLVE_TIMEOUT_MS = 3_000;

export interface SystemProxyEnv {
  /** The HTTP(S) proxy Chromium would use, or null for DIRECT. */
  proxy: { https: string; http: string } | null;
  /** Only SOCKS entries: Node's env proxy cannot use them, so the daemon stays direct. */
  socksOnly: boolean;
}

/**
 * The daemon proxy for a Chromium proxy answer such as
 * `PROXY 127.0.0.1:7890; SOCKS5 127.0.0.1:7891; DIRECT`, read in fallback
 * order: the first HTTP(S) proxy wins and DIRECT ends the list. No proxy when
 * the user set a proxy variable (theirs wins).
 */
export function proxyEnvFromResolution(resolved: string, env: NodeJS.ProcessEnv): SystemProxyEnv {
  if (PROXY_ENV_NAMES.some((name) => env[name])) return { proxy: null, socksOnly: false };
  let socks = false;
  for (const entry of resolved.split(';')) {
    const [scheme = '', hostPort] = entry.trim().split(/\s+/);
    const kind = scheme.toUpperCase();
    if (kind === 'DIRECT') break;
    if (kind.startsWith('SOCKS')) {
      socks = true;
      continue;
    }
    if ((kind === 'PROXY' || kind === 'HTTPS') && hostPort) {
      const url = `${kind === 'HTTPS' ? 'https' : 'http'}://${hostPort}`;
      return { proxy: { https: url, http: url }, socksOnly: false };
    }
  }
  return { proxy: null, socksOnly: socks };
}

/**
 * Chromium's answer (PAC, WPAD, exceptions) is authoritative for a daemon the
 * desktop forks, DIRECT included: it is always handed over as a decision, so
 * the daemon never reads the registry proxy itself.
 */
function handoff(proxy: SystemProxyEnv['proxy']): Record<string, string> {
  return { [SYSTEM_PROXY_HANDOFF_VAR]: JSON.stringify({ proxy }) };
}

let socksReported = false;

/** `scheme://host:port` of a proxy URL, never its userinfo. */
function proxyOrigin(url: string): string {
  try {
    const { protocol, host } = new URL(url);
    return `${protocol}//${host}`;
  } catch {
    return '(unparsable address)';
  }
}

/**
 * Resolve the system proxy now (each daemon fork asks again, so a changed
 * setting applies to the next daemon) and turn it into the daemon's proxy
 * handoff. A failed or slow resolution hands over DIRECT. Empty
 * when the user's own proxy variables or MIXDOG_SYSTEM_PROXY=0 decide.
 */
export async function systemProxyEnv(
  resolveProxy: (url: string) => Promise<string>,
  log: (line: string) => void,
  { ready = Promise.resolve(), env = process.env }: { ready?: Promise<unknown>; env?: NodeJS.ProcessEnv } = {}
): Promise<Record<string, string>> {
  if (env.MIXDOG_SYSTEM_PROXY === '0' || PROXY_ENV_NAMES.some((name) => env[name])) return {};
  let timer: NodeJS.Timeout | undefined;
  try {
    // The bound covers the lookup (a WPAD/PAC fetch can stall), not app start.
    await ready;
    const resolved = await Promise.race([
      resolveProxy(SYSTEM_PROXY_PROBE_URL),
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve('DIRECT'), RESOLVE_TIMEOUT_MS);
      }),
    ]);
    const result = proxyEnvFromResolution(resolved, env);
    // Logs never quote the answer, a URL or an error message: any of them may
    // carry proxy credentials (user:pass@host).
    if (result.socksOnly && !socksReported) {
      socksReported = true;
      log('system proxy is SOCKS only; the daemon connects directly');
    }
    if (result.proxy) log(`daemon uses the system proxy ${proxyOrigin(result.proxy.https)}`);
    return handoff(result.proxy);
  } catch (error) {
    log(`system proxy lookup failed (${error instanceof Error ? error.name : typeof error})`);
    return handoff(null);
  } finally {
    clearTimeout(timer);
  }
}
