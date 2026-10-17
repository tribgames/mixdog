// The desktop owns quota freshness and account proof. This daemon only asks
// for bounded observations and durably stores them under opaque subjects.
import { getModelProxyChannel } from './model-proxy-channel.mjs';
import { loadModelProxyProviderConfig } from './model-proxy-provider.mjs';
import { sanitizeModelProxyUsageReply } from './model-proxy-usage-wire.mjs';
import { recordQuotaReadings } from './lib/quota-readings.mjs';

const pending = new WeakMap();
const unavailable = () => ({ status: 'unavailable', accounts: [] });
const currentConnection = (channel, generation) => channel.connected && channel.generation === generation;

function connectionReads(channel) {
  let state = pending.get(channel);
  if (!state || state.generation !== channel.generation) {
    state = { generation: channel.generation, reads: new Map(), config: null };
    pending.set(channel, state);
  }
  return state;
}

function freshConfig(channel, state) {
  if (!state.config) {
    // Do not inherit a catalog cache or an initialization started before a
    // sign-in/sign-out. Only overlapping capability reads share this request.
    const task = loadModelProxyProviderConfig({ channel, force: true, waitMs: 1000 }).finally(() => {
      if (state.config === task) state.config = null;
    });
    state.config = task;
  }
  return state.config;
}

function readUsage(provider, { force = false, channel = getModelProxyChannel() } = {}, config = null) {
  if (!channel.connected) return Promise.resolve(unavailable());
  const state = connectionReads(channel);
  const current = () => currentConnection(channel, state.generation);
  // A forced read joins an existing measurement rather than polling twice.
  if (state.reads.has(provider)) return state.reads.get(provider);
  const task = (async () => {
    try {
      const providers = config || (await freshConfig(channel, state));
      if (!current()) return unavailable();
      if (providers[provider]?.enabled !== true) return { status: 'not-configured', accounts: [] };
      if (providers[provider]?.modelProxy?.oauthUsage !== true)
        return { status: 'unsupported-client', accounts: [] };
      const value = await channel.request(
        { method: 'oauthUsage', provider, ...(force ? { force: true } : {}) },
        { signal: AbortSignal.timeout(15_000) }
      );
      if (!current()) return unavailable();
      const reply = sanitizeModelProxyUsageReply(provider, value);
      if (reply.status === 'ready') {
        // Re-reading a PC cache is not a new observation. SQLite's existing
        // deduplication also applies after a durable ledger reopen.
        const saved = await recordQuotaReadings(
          provider,
          reply.account,
          reply.snapshot,
          () => {},
          reply.snapshot.cachedAt,
          current
        );
        if (!current()) return unavailable();
        if (!saved) return { status: 'unavailable', accounts: reply.accounts, account: reply.account };
      }
      return current() ? reply : unavailable();
    } catch {
      return unavailable();
    }
  })().finally(() => {
    if (state.reads.get(provider) === task) state.reads.delete(provider);
  });
  state.reads.set(provider, task);
  return task;
}

export function readRemoteOAuthUsage(provider, options = {}) {
  return readUsage(provider, options);
}

export async function remoteQuotaScope({ channel = getModelProxyChannel(), provider = '' } = {}) {
  const generation = channel.generation;
  const current = () => currentConnection(channel, generation);
  const retired = () => ({ scopes: {}, inUse: {}, status: 'unavailable', current: () => false });
  try {
    if (!current()) return retired();
    const config = await freshConfig(channel, connectionReads(channel));
    if (!current()) return retired();
    const providers = Object.keys(config).filter(
      (id) => id.endsWith('-oauth') && config[id]?.enabled === true && (!provider || id === provider)
    );
    const readings = await Promise.all(
      providers.map(async (id) => [id, await readUsage(id, { channel }, config)])
    );
    if (!current()) return retired();
    const scopes = {};
    const inUse = {};
    for (const [id, reply] of readings) {
      // Ownership survives an unavailable/unsupported measurement. Every
      // authenticated identity may have historical observations, not just the
      // account selected for today's measurement.
      scopes[id] = reply.accounts;
      if (reply.account) inUse[id] = reply.account;
    }
    const statuses = readings.map(([, reply]) => reply.status);
    const status = statuses.includes('unavailable')
      ? 'unavailable'
      : statuses.includes('ready')
        ? 'ready'
        : statuses.includes('unsupported-client')
          ? 'unsupported-client'
          : statuses.length
            ? 'unsupported'
            : 'not-configured';
    return { scopes, inUse, status, current };
  } catch {
    return retired();
  }
}
