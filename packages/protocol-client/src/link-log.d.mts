export const LINK_EVENTS: ReadonlySet<string>;
/** `fn` that cannot throw into, delay or reorder its caller: it runs in a microtask and its failures stay in it. */
export function contained<A extends unknown[]>(fn: (...args: A) => unknown): (...args: A) => void;
/** The log of one owner; `identity` is merged last into every line, and an event outside `LINK_EVENTS` is dropped. */
export function createLinkLog(
  sink: ((event: string, fields: Record<string, unknown>) => void) | undefined,
  identity?: Record<string, unknown>
): (event: string, fields?: Record<string, unknown>) => void;
