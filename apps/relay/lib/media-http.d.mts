// Types for the shared media-transport helpers (consumed by the desktop LAN
// bridge and the Electron media protocol; the relay runs the .mjs directly).
import type { IncomingMessage, ServerResponse } from 'node:http';

export declare function parseMediaRequest(
  pathname: string,
  searchParams: URLSearchParams,
): { assetId: string; variant: string } | null;
export declare function mediaEtag(assetId: string, variant: string, bytes: number): string;
export declare function parseRange(
  header: string | string[] | undefined | null,
  size: number,
): { start: number; end: number } | { unsatisfiable: true } | null;
export declare function mediaResponsePlan(input: {
  size: number;
  mime: string;
  assetId: string;
  variant: string;
  rangeHeader?: string | string[] | null;
  ifNoneMatch?: string | string[] | null;
  cacheControl?: string;
}): {
  status: number;
  headers: Record<string, string | number>;
  start: number;
  end: number;
};
export declare function sendMediaFile(
  request: IncomingMessage,
  response: ServerResponse,
  file: { path: string; mime: string; assetId: string; variant: string },
): void;
