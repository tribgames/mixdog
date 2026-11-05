// `node:http2` stand-in: client sessions connect (h2c) to the local hub.
import * as real from 'node:http2';

export function connect(authority, options, listener) {
  const hub = globalThis.__benchHub;
  if (!hub?.h2Port) return real.connect(authority, options, listener);
  hub.lastH2Origin = String(authority);
  const { ALPNProtocols, servername, ca, ...rest } = options ?? {};
  return real.connect(`http://127.0.0.1:${hub.h2Port}`, rest, listener);
}

export const { constants, createServer, createSecureServer, getDefaultSettings, getPackedSettings, getUnpackedSettings, sensitiveHeaders } = real;
export default { ...real, connect };
