import { isConversationUsageSource } from '../runtime/shared/llm/usage-rollup.mjs';

const HOUR_MS = 60 * 60 * 1000;
const amount = (value) => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : 0;

/** Only retained timestamps establish an hour. Legacy day totals stay unallocated. */
export function hourlySeries(records, period, conversationOnly = false) {
  const make = (key, label, future = false) => ({
    key, label, future, turns: 0, tokens: 0, costUsd: 0, providers: new Map(),
  });
  const buckets = [];
  // Real elapsed hours also handle 23/25-hour daylight-saving days.
  for (let ts = period.fromMs; ts <= period.endMs; ts += HOUR_MS) {
    const label = `${String(new Date(ts).getHours()).padStart(2, '0')}:00`;
    buckets.push(make(String(ts), label, ts > period.toMs));
  }
  const add = (bucket, provider, turns, tokens, costUsd) => {
    bucket.turns += turns;
    bucket.tokens += tokens;
    bucket.costUsd += costUsd;
    const slice = bucket.providers.get(provider) || { provider, turns: 0, tokens: 0, costUsd: 0 };
    slice.turns += turns;
    slice.tokens += tokens;
    slice.costUsd += costUsd;
    bucket.providers.set(provider, slice);
  };
  for (const row of records?.rows || []) {
    if (row.ts < period.fromMs || row.ts > period.toMs) continue;
    if (conversationOnly && !isConversationUsageSource(row.source_type)) continue;
    const bucket = buckets[Math.floor((row.ts - period.fromMs) / HOUR_MS)];
    if (bucket) add(bucket, row.provider, 1, amount(row.input) + amount(row.output), amount(row.cost_usd));
  }
  const unknown = { ...make('unknown-time', ''), unknown: true };
  for (const route of records?.unallocated || []) {
    const usage = conversationOnly ? route.conversation : route;
    if (usage) add(unknown, route.provider, amount(usage.turns),
      amount(usage.input) + amount(usage.output), amount(usage.costUsd));
  }
  if (unknown.turns || unknown.tokens || unknown.costUsd) buckets.push(unknown);
  return buckets.map((bucket) => ({
    ...bucket,
    costUsd: Number(bucket.costUsd.toFixed(6)),
    providers: [...bucket.providers.values()].map((slice) => ({
      ...slice, costUsd: Number(slice.costUsd.toFixed(6)),
    })),
  }));
}
