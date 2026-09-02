/**
 * How the runtime finds this bridge, and how one request is read and answered.
 * The discovery file is the only thing that makes the tool surface appear, so
 * it is written after the backend is warm and removed the moment it is not.
 */
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  parseBridgeDiscovery,
  probeBridgeDiscovery,
  sameBridgeDiscovery,
  type BridgeDiscoveryProbeOutcome,
  type BridgeDiscoveryRecord,
} from './discovery-ownership';

const DISCOVERY_FILE = 'computer-bridge.json';
const MAX_REQUEST_BYTES = 256 * 1024;

export interface DiscoveryHost {
  /** Where the discovery file belongs, resolved at write time. */
  dataDirectory(): string;
  probeDiscovery?: (record: BridgeDiscoveryRecord) => Promise<BridgeDiscoveryProbeOutcome>;
}

export function createBridgeDiscovery(host: DiscoveryHost) {
  const { dataDirectory } = host;
  const probeDiscovery = host.probeDiscovery || probeBridgeDiscovery;
  let discoveryPath: string | null = null;
  let activeDiscovery: BridgeDiscoveryRecord | null = null;

  type DiscoverySnapshot = {
    state: 'missing' | 'present' | 'unreadable';
    raw: string | null;
    record: BridgeDiscoveryRecord | null;
  };

  function ensureDiscoveryPath(): string {
    const directory = dataDirectory();
    mkdirSync(directory, { recursive: true });
    discoveryPath = join(directory, DISCOVERY_FILE);
    return discoveryPath;
  }

  function readDiscoverySnapshot(path: string): DiscoverySnapshot {
    try {
      const raw = readFileSync(path, 'utf8');
      let value: unknown = null;
      try {
        value = JSON.parse(raw);
      } catch {
        return { state: 'present', raw, record: null };
      }
      return { state: 'present', raw, record: parseBridgeDiscovery(value) };
    } catch (error) {
      return (error as NodeJS.ErrnoException)?.code === 'ENOENT'
        ? { state: 'missing', raw: null, record: null }
        : { state: 'unreadable', raw: null, record: null };
    }
  }

  function publishDiscovery(record: BridgeDiscoveryRecord): boolean {
    const path = ensureDiscoveryPath();
    const temporaryPath = `${path}.${process.pid}.${record.generation}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      writeFileSync(temporaryPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
      renameSync(temporaryPath, path);
      try {
        chmodSync(path, 0o600);
      } catch { /* Windows ACLs: the per-user data dir is already private */ }
    } finally {
      try {
        unlinkSync(temporaryPath);
      } catch { /* renamed or already gone */ }
    }
    return sameBridgeDiscovery(readDiscoverySnapshot(path).record, record);
  }

  async function maintainDiscovery(
    record: BridgeDiscoveryRecord,
  ): Promise<'owned' | 'occupied' | 'inconclusive' | 'lost' | 'superseded'> {
    if (!sameBridgeDiscovery(activeDiscovery, record)) return 'superseded';
    const path = ensureDiscoveryPath();
    const first = readDiscoverySnapshot(path);
    if (first.state === 'unreadable') return 'inconclusive';
    if (first.state === 'missing') {
      const confirmation = readDiscoverySnapshot(path);
      if (confirmation.state !== 'missing') return 'inconclusive';
      return publishDiscovery(record) ? 'owned' : 'inconclusive';
    }
    if (!first.record) return 'inconclusive';
    const sameOwner = sameBridgeDiscovery(first.record, record);
    const outcome = await probeDiscovery(first.record);
    if (!sameBridgeDiscovery(activeDiscovery, record)) return 'superseded';
    if (sameOwner) {
      if (outcome === 'dead') return 'lost';
      if (outcome !== 'live') return 'inconclusive';
      const current = readDiscoverySnapshot(path);
      if (!sameBridgeDiscovery(current.record, record)) return 'inconclusive';
      const now = new Date();
      utimesSync(path, now, now);
      return 'owned';
    }
    if (outcome === 'live') return 'occupied';
    if (outcome !== 'dead') return 'inconclusive';
    const current = readDiscoverySnapshot(path);
    if (current.raw !== first.raw || !sameBridgeDiscovery(current.record, first.record)) {
      return 'inconclusive';
    }
    return publishDiscovery(record) ? 'owned' : 'inconclusive';
  }

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

  async function writeDiscovery(
    record: BridgeDiscoveryRecord,
  ): Promise<'owned' | 'occupied' | 'inconclusive' | 'lost' | 'superseded'> {
    activeDiscovery = record;
    return await maintainDiscovery(record);
  }

  async function heartbeatDiscovery(
    record: BridgeDiscoveryRecord,
  ): Promise<'owned' | 'occupied' | 'inconclusive' | 'lost' | 'superseded'> {
    return await maintainDiscovery(record);
  }

  function removeDiscovery(record: BridgeDiscoveryRecord): void {
    if (!sameBridgeDiscovery(activeDiscovery, record)) return;
    activeDiscovery = null;
    if (!discoveryPath) return;
    try {
      const current = readDiscoverySnapshot(discoveryPath);
      if (sameBridgeDiscovery(current.record, record)) unlinkSync(discoveryPath);
    } catch { /* replaced or already gone */ }
    discoveryPath = null;
  }

  return { readRequestBody, respond, writeDiscovery, heartbeatDiscovery, removeDiscovery };
}
