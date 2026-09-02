/**
 * Ownership of one bridge discovery file (Computer Use, Browser Use): the
 * record shape, identity comparison, and the /health probe that tells a live
 * foreign owner from a crashed one so a surviving instance can reclaim the file.
 */
import { request } from 'node:http';

export const BRIDGE_DISCOVERY_VERSION = 1;
const HEALTH_PROBE_TIMEOUT_MS = 750;
const MAX_HEALTH_RESPONSE_BYTES = 16 * 1024;
const DEAD_ENDPOINT_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOENT']);

export interface BridgeDiscoveryRecord {
  version: number;
  port: number;
  token: string;
  pid: number;
  generation: number;
  startedAt: number;
}

export type BridgeDiscoveryProbeOutcome = 'live' | 'dead' | 'inconclusive';

export function createBridgeDiscoveryRecord({
  port,
  token,
  generation,
  startedAt = Date.now(),
  pid = process.pid,
}: {
  port: number;
  token: string;
  generation: number;
  startedAt?: number;
  pid?: number;
}): BridgeDiscoveryRecord {
  return {
    version: BRIDGE_DISCOVERY_VERSION,
    port,
    token,
    pid,
    generation,
    startedAt,
  };
}

export function parseBridgeDiscovery(value: unknown): BridgeDiscoveryRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const parsed = value as Partial<BridgeDiscoveryRecord>;
  const version = Number(parsed.version);
  const port = Number(parsed.port);
  const token = String(parsed.token || '');
  const pid = Number(parsed.pid || 0);
  const generation = Number(parsed.generation || 0);
  const startedAt = Number(parsed.startedAt || 0);
  if (version !== BRIDGE_DISCOVERY_VERSION
    || !Number.isInteger(port) || port <= 0 || port > 65_535
    || !token
    || !Number.isInteger(pid) || pid < 0
    || !Number.isInteger(generation) || generation < 0
    || !Number.isFinite(startedAt) || startedAt < 0) return null;
  return { version, port, token, pid, generation, startedAt };
}

export function sameBridgeDiscovery(
  left: BridgeDiscoveryRecord | null,
  right: BridgeDiscoveryRecord | null,
): boolean {
  return Boolean(left && right
    && left.version === right.version
    && left.port === right.port
    && left.token === right.token
    && left.pid === right.pid
    && left.generation === right.generation
    && left.startedAt === right.startedAt);
}

export function bridgeDiscoveryPublicIdentity(record: BridgeDiscoveryRecord): Omit<BridgeDiscoveryRecord, 'token'> {
  const { token: _token, ...identity } = record;
  return identity;
}

function samePublicIdentity(
  record: BridgeDiscoveryRecord,
  value: unknown,
): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const identity = value as Partial<Omit<BridgeDiscoveryRecord, 'token'>>;
  return Number(identity.version) === record.version
    && Number(identity.port) === record.port
    && Number(identity.pid) === record.pid
    && Number(identity.generation) === record.generation
    && Number(identity.startedAt) === record.startedAt;
}

export async function probeBridgeDiscovery(
  record: BridgeDiscoveryRecord,
): Promise<BridgeDiscoveryProbeOutcome> {
  return await new Promise<BridgeDiscoveryProbeOutcome>((resolve) => {
    let settled = false;
    let responseText = '';
    const finish = (outcome: BridgeDiscoveryProbeOutcome): void => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };
    const probe = request({
      host: '127.0.0.1',
      port: record.port,
      path: '/health',
      method: 'GET',
      headers: { authorization: `Bearer ${record.token}` },
      agent: false,
    }, (response) => {
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        responseText += chunk;
        if (Buffer.byteLength(responseText) > MAX_HEALTH_RESPONSE_BYTES) {
          probe.destroy();
          finish('inconclusive');
        }
      });
      response.on('end', () => {
        if (response.statusCode !== 200) {
          finish('inconclusive');
          return;
        }
        try {
          const payload = JSON.parse(responseText) as { ok?: boolean; identity?: unknown };
          finish(payload.ok === true && samePublicIdentity(record, payload.identity)
            ? 'live'
            : 'inconclusive');
        } catch {
          finish('inconclusive');
        }
      });
    });
    probe.setTimeout(HEALTH_PROBE_TIMEOUT_MS, () => {
      probe.destroy();
      finish('inconclusive');
    });
    probe.on('error', (error: NodeJS.ErrnoException) => {
      finish(DEAD_ENDPOINT_CODES.has(String(error.code || '')) ? 'dead' : 'inconclusive');
    });
    probe.end();
  });
}
