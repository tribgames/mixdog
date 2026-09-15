// Types for the relay static-serving helpers (the relay runs the .mjs
// directly; this declaration file is for TypeScript consumers).
import type { IncomingMessage, ServerResponse } from 'node:http';

export declare const MIME_TYPES: Record<string, string>;
export declare const HASHED_ASSET_NAME: RegExp;
export declare const PAIRING_COOKIE_NAME: string;
export declare const DEVICE_COOKIE_NAME: string;
export declare const BROWSER_SECURITY_HEADERS: Readonly<Record<string, string>>;
export declare function parseCookieToken(header: string | undefined): string;
export declare function parseCookieDevice(header: string | undefined): string;
export declare function pairingCookieHeaders(
  queryToken: string,
  request?: IncomingMessage,
): Record<string, string>;
export declare function deviceCookieHeaders(
  deviceId: string,
  request?: IncomingMessage,
): Record<string, string>;
/** One response may set several cookies, so the merged value is an array. */
export declare function mergeCookieHeaders(
  ...headerSets: Array<Record<string, string | string[]> | undefined>
): Record<string, string[]>;
export declare function sendDeviceManifest(
  request: IncomingMessage,
  response: ServerResponse,
  target: string,
  deviceId: string,
): boolean;
export declare function resolveStaticTarget(
  rootDir: string,
  pathname: string,
): { status: 200 | 403 | 404; target: string };
export declare function parseAcceptEncoding(
  header: string | string[] | undefined,
): Map<string, number>;
export declare function encodingAccepted(
  header: string | string[] | undefined,
  encoding: string,
): boolean;
export declare function selectPrecompressed(
  target: string,
  acceptEncoding: string | string[] | undefined,
  fileExists?: (path: string) => boolean,
): { path: string; encoding: 'br' | 'gzip' } | null;
export declare function sendStaticFile(
  request: IncomingMessage,
  response: ServerResponse,
  target: string,
  extraHeaders?: Record<string, string | string[]>,
): void;
