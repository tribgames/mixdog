// Types for the shared static-serving helpers (consumed by the desktop LAN
// bridge, which is TypeScript; the relay itself runs the .mjs directly).
import type { IncomingMessage, ServerResponse } from 'node:http';

export declare const MIME_TYPES: Record<string, string>;
export declare const PAIRING_COOKIE_NAME: string;
export declare const BROWSER_SECURITY_HEADERS: Readonly<Record<string, string>>;
export declare function parseCookieToken(header: string | undefined): string;
export declare function pairingCookieHeaders(
  queryToken: string,
  request?: IncomingMessage,
): Record<string, string>;
export declare function resolveStaticTarget(
  rootDir: string,
  pathname: string,
): { status: 200 | 403 | 404; target: string };
export declare function sendStaticFile(
  request: IncomingMessage,
  response: ServerResponse,
  target: string,
  extraHeaders?: Record<string, string>,
): void;
