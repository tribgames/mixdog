export function canonicalRouteProvider(value: unknown): string;
export function routeChain(route: Record<string, unknown>): Record<string, unknown>[];
export function executionFallbacks(route: Record<string, unknown> | null | undefined): Record<string, unknown>[];
export function validateRouteChainProviders(
  routes: Record<string, unknown>[],
  options?: { allowDuplicates?: boolean }
): void;
export function normalizeRouteChain(
  route: Record<string, unknown>,
  normalizeLeaf: (route: Record<string, unknown>, fallback: Record<string, unknown>) => Record<string, unknown> | null,
  fallback?: Record<string, unknown>,
  options?: { strict?: boolean }
): Record<string, unknown> | null;
