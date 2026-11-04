// Settings → System → Network proxy: how Mixdog reaches AI services. The
// setting lives in the PC's runtime config; every surface (this window, a
// paired phone) reads and edits it through these capabilities.

export type NetworkProxyMode = 'system' | 'manual' | 'off';

/** What the setting does now, as facts for the row's description. */
export interface NetworkProxyRoute {
  /** off, manual, env (a proxy variable), system (the OS proxy) or direct. */
  via: 'off' | 'manual' | 'env' | 'system' | 'direct';
  /** `host:port` of the proxy in use, never credentials. */
  proxy: string | null;
  envVar: string | null;
  /** Under `off`: what exists and is not followed. */
  ignored: { system: boolean; env: string[] };
  noProxyAll: boolean;
  platform: 'windows' | 'macos' | 'other';
  /** A manual proxy without an address. */
  error: 'no-address' | null;
}

export interface DesktopNetworkProxySettings {
  mode: NetworkProxyMode;
  url: string;
  exceptions: string;
  /** The endpoint the route and the check refer to: the main provider's, else api.openai.com. */
  origin: string;
  route: NetworkProxyRoute;
}

export interface DesktopNetworkProxyPatch {
  mode?: NetworkProxyMode;
  url?: string;
  exceptions?: string;
}

/** Options naming the main route's provider, whose endpoint the check and the route description use. */
export interface DesktopNetworkProxyOptions {
  provider?: string;
}

export interface DesktopNetworkProxyCheck {
  ok: boolean;
  ms: number;
  origin: string;
  status?: number;
  /** ECONNREFUSED, ETIMEDOUT, ... when the connection failed. */
  code?: string;
  route: NetworkProxyRoute;
}

export const NETWORK_PROXY_MODES: readonly NetworkProxyMode[] = ['system', 'manual', 'off'];
export const DEFAULT_NETWORK_PROXY_EXCEPTIONS = 'localhost, 127.0.0.1, ::1';

/**
 *  getNetworkProxy(options?) → DesktopNetworkProxySettings
 *  setNetworkProxy(patch, options?) → DesktopNetworkProxySettings (rejects an invalid value; nothing is stored)
 *  testNetworkProxy(options?) → DesktopNetworkProxyCheck */
export const DESKTOP_NETWORK_PROXY_CAPABILITIES = ['getNetworkProxy', 'setNetworkProxy', 'testNetworkProxy'] as const;

export const DESKTOP_NETWORK_PROXY_READ_CAPABILITIES = ['getNetworkProxy', 'testNetworkProxy'] as const;
