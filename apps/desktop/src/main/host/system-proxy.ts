/**
 * `host/systemProxy/resolve{url}` → `{rules}`: Chromium's answer for the OS
 * proxy of one origin (WinINET, macOS settings, PAC, WPAD). The core goes
 * DIRECT when this does not answer in time. A failure answers with the
 * error's name only: its message may quote a PAC URL with credentials.
 */
import { HOST_COMMAND_FAILED, HOST_INVALID_PARAMS, HOST_METHOD, type HostConnection, HostRpcError, objectParams } from './connection';

export function registerSystemProxyHost(connection: HostConnection, resolveProxy: (url: string) => Promise<string>): void {
  connection.handleRequest(HOST_METHOD.systemProxyResolve, async (params) => {
    const { url: raw } = objectParams(params, HOST_METHOD.systemProxyResolve);
    let origin: string;
    try {
      const url = new URL(String(raw));
      if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new TypeError('not an http(s) origin');
      origin = url.origin;
    } catch (error) {
      throw new HostRpcError(HOST_INVALID_PARAMS, error instanceof Error ? error.name : 'Error');
    }
    try {
      return { rules: await resolveProxy(origin) };
    } catch (error) {
      throw new HostRpcError(HOST_COMMAND_FAILED, error instanceof Error ? error.name : 'Error');
    }
  });
}
