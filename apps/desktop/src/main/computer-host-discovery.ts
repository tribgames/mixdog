/**
 * How the runtime finds this bridge, and how one request is read and answered.
 * The discovery file is the only thing that makes the tool surface appear, so
 * it is written after the backend is warm and removed the moment it is not.
 */
import { chmodSync, mkdirSync, readFileSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

const DISCOVERY_FILE = 'computer-bridge.json';
const DISCOVERY_VERSION = 1;
const MAX_REQUEST_BYTES = 256 * 1024;

export interface DiscoveryHost {
  /** Where the discovery file belongs, resolved at write time. */
  dataDirectory(): string;
}

export function createBridgeDiscovery(host: DiscoveryHost) {
  const { dataDirectory } = host;
  let discoveryPath: string | null = null;

  async function readRequestBody(request: IncomingMessage): Promise<string> {
    return await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      request.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_REQUEST_BYTES) {
          reject(new Error('request too large'));
          request.destroy();
          return;
        }
        chunks.push(chunk);
      });
      request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      request.on('error', reject);
    });
  }

  function respond(response: ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    response.writeHead(status, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload),
    });
    response.end(payload);
  }

  function writeDiscovery(port: number, activeToken: string): void {
    const directory = dataDirectory();
    mkdirSync(directory, { recursive: true });
    discoveryPath = join(directory, DISCOVERY_FILE);
    writeFileSync(discoveryPath, `${JSON.stringify({
      version: DISCOVERY_VERSION,
      port,
      token: activeToken,
      pid: process.pid,
      startedAt: Date.now(),
    })}\n`);
    try {
      chmodSync(discoveryPath, 0o600);
    } catch { /* Windows ACLs: the per-user data dir is already private */ }
  }

  function heartbeatDiscovery(port: number, activeToken: string): void {
    if (!discoveryPath) return;
    try {
      const now = new Date();
      utimesSync(discoveryPath, now, now);
    } catch {
      try {
        writeDiscovery(port, activeToken);
      } catch { /* data dir gone mid-shutdown */ }
    }
  }

  function removeDiscovery(activeToken: string): void {
    if (!discoveryPath) return;
    try {
      const current = JSON.parse(readFileSync(discoveryPath, 'utf8')) as { token?: string };
      if (current?.token === activeToken) unlinkSync(discoveryPath);
    } catch { /* replaced or already gone */ }
    discoveryPath = null;
  }

  return { readRequestBody, respond, writeDiscovery, heartbeatDiscovery, removeDiscovery };
}
