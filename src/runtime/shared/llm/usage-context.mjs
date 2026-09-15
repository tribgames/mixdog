import { AsyncLocalStorage } from 'node:async_hooks';

// The selected route owns accounting identity, not an inner transport adapter.
const context = new AsyncLocalStorage();
export const withUsageContext = (identity, send) => context.run(identity, send);
export const currentUsageContext = () => context.getStore();
