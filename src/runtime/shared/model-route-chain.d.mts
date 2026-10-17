export function canonicalRouteProvider(value: unknown): string;
export function routeChain(route: Record<string, unknown>): Record<string, unknown>[];
export function validateRouteChainProviders(routes: Record<string, unknown>[]): void;
export function normalizeRouteChain(
  route: Record<string, unknown>,
  normalizeLeaf: (route: Record<string, unknown>, fallback: Record<string, unknown>) => Record<string, unknown> | null,
  fallback?: Record<string, unknown>
): Record<string, unknown> | null;
