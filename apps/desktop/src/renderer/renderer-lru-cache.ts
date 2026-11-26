import { enforceRendererCacheBudget, registerBudgetedCache } from './renderer-cache-budget';

/** Weighted LRU for recomputable renderer data. Measurements use the shared
 * budget's character-equivalent units (estimated JS bytes / 2). */
export class RendererLruCache<K, V> {
  private readonly entries = new Map<K, { value: V; chars: number }>();
  private retained = 0;
  private unregister: (() => void) | null = null;

  constructor(
    private readonly options: {
      name: string;
      maxEntries: number;
      maxChars: number;
      measure(value: V, key: K): number;
      isPinned?(key: K): boolean;
      onTrim?(): void;
      register?: boolean;
    }
  ) {
    if (options.register !== false) this.register();
  }

  private pinnedChars(): number {
    const isPinned = this.options.isPinned;
    if (!isPinned) return 0;
    let total = 0;
    for (const [key, entry] of this.entries) {
      if (isPinned(key)) total += entry.chars;
    }
    return total;
  }

  register(): void {
    if (this.unregister) return;
    this.unregister = registerBudgetedCache({
      name: this.options.name,
      chars: () => this.retained,
      ...(this.options.isPinned ? { pinned: () => this.pinnedChars() } : {}),
      trim: (target) => this.trim(target),
    });
    enforceRendererCacheBudget();
  }

  get size(): number {
    return this.entries.size;
  }
  chars(): number {
    return this.retained;
  }

  /** Read without refreshing recency. */
  peek(key: K): V | undefined {
    return this.entries.get(key)?.value;
  }

  get(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V): void {
    const prevChars = this.entries.get(key)?.chars ?? 0;
    this.delete(key);
    const chars = this.options.measure(value, key);
    if (!Number.isFinite(chars) || chars < 0 || chars > this.options.maxChars) return;
    this.entries.set(key, { value, chars });
    this.retained += chars;
    this.trim(this.options.maxChars);
    if (this.unregister && chars > prevChars) enforceRendererCacheBudget();
  }

  delete(key: K): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.retained -= entry.chars;
    this.entries.delete(key);
  }

  deletePrefix(prefix: string): void {
    for (const key of [...this.entries.keys()]) if (typeof key === 'string' && key.startsWith(prefix)) this.delete(key);
  }

  trim(target: number): void {
    const isPinned = this.options.isPinned;
    let evicted = false;
    for (const key of [...this.entries.keys()]) {
      if (this.entries.size <= this.options.maxEntries && this.retained <= target) break;
      if (isPinned?.(key)) continue;
      this.delete(key);
      evicted = true;
    }
    if (evicted) this.options.onTrim?.();
  }

  clear(): void {
    this.entries.clear();
    this.retained = 0;
  }

  dispose(): void {
    this.unregister?.();
    this.unregister = null;
    this.clear();
  }
}
