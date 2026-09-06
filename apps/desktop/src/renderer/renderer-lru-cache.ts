import { enforceRendererCacheBudget, registerBudgetedCache } from "./renderer-cache-budget";

/** Weighted LRU for recomputable renderer data. Measurements use the shared
 * budget's character-equivalent units (estimated JS bytes / 2). */
export class RendererLruCache<K, V> {
  private readonly entries = new Map<K, { value: V; chars: number }>();
  private retained = 0;
  private unregister: (() => void) | null = null;

  constructor(private readonly options: {
    name: string;
    maxEntries: number;
    maxChars: number;
    measure(value: V, key: K): number;
    register?: boolean;
  }) {
    if (options.register !== false) this.register();
  }

  register(): void {
    if (this.unregister) return;
    this.unregister = registerBudgetedCache({
      name: this.options.name,
      chars: () => this.retained,
      trim: (target) => this.trim(target),
    });
    enforceRendererCacheBudget();
  }

  get size(): number { return this.entries.size; }
  chars(): number { return this.retained; }

  get(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V): void {
    this.delete(key);
    const chars = this.options.measure(value, key);
    if (!Number.isFinite(chars) || chars < 0 || chars > this.options.maxChars) return;
    this.entries.set(key, { value, chars });
    this.retained += chars;
    this.trim(this.options.maxChars);
    if (this.unregister) enforceRendererCacheBudget();
  }

  delete(key: K): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.retained -= entry.chars;
    this.entries.delete(key);
  }

  trim(target: number): void {
    while (this.entries.size > this.options.maxEntries || this.retained > target) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.delete(oldest.value);
    }
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
