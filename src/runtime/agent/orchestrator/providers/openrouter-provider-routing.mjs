/**
 * OpenRouter provider routing: the per-model `providerSort` picker parameter
 * and the request's `provider: { sort }` field. Auto (the default) sends
 * nothing; a stored value outside the known sorts is dropped.
 */
export const OPENROUTER_SORT_PARAMETER = 'providerSort';

const SORTS = new Set(['price', 'throughput', 'latency']);

export const OPENROUTER_SORT_OPTION = Object.freeze({
  id: OPENROUTER_SORT_PARAMETER,
  label: 'Routing',
  kind: 'enum',
  options: [
    { value: 'auto', label: 'Auto' },
    { value: 'price', label: 'Price first' },
    { value: 'throughput', label: 'Speed first' },
    { value: 'latency', label: 'Latency first' },
  ],
});

/** `{ sort }` for the request body's `provider` field, or null for Auto or an unknown value. */
export function openRouterProviderRouting(opts = {}) {
  const sort = String(opts?.modelParameters?.[OPENROUTER_SORT_PARAMETER] ?? '')
    .trim()
    .toLowerCase();
  return SORTS.has(sort) ? { sort } : null;
}
