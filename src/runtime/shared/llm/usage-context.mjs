import { AsyncLocalStorage } from 'node:async_hooks';

// The selected route owns accounting identity, not an inner transport adapter.
const context = new AsyncLocalStorage();
export const withUsageContext = (identity, send) => context.run(identity, send);
export const currentUsageContext = () => context.getStore();
// Each wire attempt stamps the tier it actually sent on its own send's
// context object, so the last attempt (the one that produced the usage) wins
// and concurrent sends never observe each other's tier.
export const noteRequestServiceTier = (tier) => {
  const identity = context.getStore();
  if (identity) identity.requestServiceTier = tier || '';
};
// Usage objects already handed to a send's accounting, as given and as
// stored. Noting is idempotent, and an error that surfaces later carrying the
// same usage (an earlier attempt's error re-thrown) is not recorded again.
const notedUsage = new WeakSet();
export const isNotedUsage = (usage) => typeof usage === 'object' && usage !== null && notedUsage.has(usage);
// A provider-local retry abandons an attempt the provider still billed; the
// enclosing send records it alongside its own final usage.
export const noteAbandonedUsage = (usage, model) => {
  const identity = context.getStore();
  if (!identity || !usage || notedUsage.has(usage)) return;
  const stored = identity.normalizeAbandonedUsage?.(usage) ?? usage;
  notedUsage.add(usage);
  notedUsage.add(stored);
  identity.abandonedUsage ||= [];
  identity.abandonedUsage.push({ usage: stored, model });
};
