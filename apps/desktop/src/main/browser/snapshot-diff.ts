/** Semantic report comparison only; never supplies identity for input recovery. */
import type { BrowserSnapshotElement } from './accessibility';
import { browserRefStateKey, type BrowserRefSet } from './ref-recovery';

export function diffSnapshotElements(
  elements: BrowserSnapshotElement[],
  previous: BrowserRefSet,
): { changed: BrowserSnapshotElement[]; unchanged: number; gone: number } {
  const remaining = new Map<string, number>();
  const identities = new Map<string, number>();
  const identity = (entry: { role: string; name: string; href?: string }) =>
    JSON.stringify([entry.role, entry.name, entry.href || '']);
  for (const entry of previous.refs.values()) {
    const key = browserRefStateKey(entry);
    remaining.set(key, (remaining.get(key) || 0) + 1);
    const id = identity(entry);
    identities.set(id, (identities.get(id) || 0) + 1);
  }
  const changed: BrowserSnapshotElement[] = [];
  let unchanged = 0;
  for (const element of elements) {
    const key = browserRefStateKey(element);
    const left = remaining.get(key) || 0;
    if (left > 0) {
      remaining.set(key, left - 1);
      unchanged++;
    } else {
      changed.push(element);
    }
    const id = identity(element);
    identities.set(id, Math.max(0, (identities.get(id) || 0) - 1));
  }
  // A value/focus change is not a disappearance. Multiplicity still matters
  // when controls have identical names; these keys never authorize an action.
  return { changed, unchanged, gone: [...identities.values()].reduce((sum, count) => sum + count, 0) };
}
