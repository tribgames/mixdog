// What is derived from a list in order, carried on from the list held before: the entries a frame left in place are not read
// again. A derivation lives with the list or the entry it was made from (WeakMap, WeakRef), never by count or age.

/** How many leading entries of `next` are the entries of `prior`, in the same places: a comparison of references (and of
 *  values, for strings), which reads nothing of an entry. */
export function sharedPrefix(
  next: readonly unknown[],
  prior: readonly unknown[] | null | undefined,
  /** Entries already known to be shared. */
  from = 0
): number {
  if (!prior) return 0;
  if (next === prior) return next.length;
  const end = Math.min(next.length, prior.length);
  let at = Math.min(from, end);
  while (at < end && next[at] === prior[at]) at += 1;
  return at;
}

const carried = new WeakMap<readonly unknown[], { prior: WeakRef<readonly unknown[]>; kept: number }>();

/** `next` was made from `prior` with (at least) its first `kept` entries left in place. */
export function noteCarried(next: readonly unknown[], prior: readonly unknown[], kept: number): void {
  if (next !== prior) carried.set(next, { prior: new WeakRef(prior), kept });
}

/** The list `next` was made from, and how many of its leading entries `next` left in place; undefined when none was noted
 *  or that list is gone. */
export function carriedFrom(next: readonly unknown[]): { prior: readonly unknown[]; kept: number } | undefined {
  const note = carried.get(next);
  const prior = note?.prior.deref();
  return note && prior ? { prior, kept: Math.min(note.kept, next.length, prior.length) } : undefined;
}

/** The leading entries of `next` known to be `prior`'s, in place: what the list's maker noted, else found by comparison. */
export function keptFrom(next: readonly unknown[], prior: readonly unknown[] | null | undefined): number {
  if (!prior) return 0;
  if (next === prior) return next.length;
  const note = carried.get(next);
  return note && note.prior.deref() === prior ? Math.min(note.kept, next.length, prior.length) : sharedPrefix(next, prior);
}

/** A count and a sum over the entries of a list that `valueOf` gives a number for, by the list. A list made from one
 *  already summed (`noteCarried`) takes that sum on: only the entries after the ones left in place are read. A sum of
 *  values that leave the place out is the same for any order of the entries; `placedHash` puts the place in. */
export function carriedSum<T>(
  valueOf: (entry: T, index: number) => number | undefined
): (list: readonly T[]) => { count: number; sum: number } {
  const totals = new WeakMap<readonly T[], { count: number; sum: number }>();
  return (list) => {
    const known = totals.get(list);
    if (known) return known;
    const made = carriedFrom(list);
    const prior = made?.prior as readonly T[] | undefined;
    const base = prior ? totals.get(prior) : undefined;
    const from = base && made ? made.kept : 0;
    let count = base?.count ?? 0;
    let sum = base?.sum ?? 0;
    if (base && prior) {
      for (let index = from; index < prior.length; index += 1) {
        const value = valueOf(prior[index] as T, index);
        if (value === undefined) continue;
        count -= 1;
        sum = (sum - value) | 0;
      }
    }
    for (let index = from; index < list.length; index += 1) {
      const value = valueOf(list[index] as T, index);
      if (value === undefined) continue;
      count += 1;
      sum = (sum + value) | 0;
    }
    const total = { count, sum };
    totals.set(list, total);
    return total;
  };
}

/** The place of the last entry of a list that `matches` (-1: none), by the list. A list made from one already searched
 *  (`noteCarried`) is searched only from the entries it did not leave in place. */
export function carriedLast<T>(matches: (entry: T) => boolean): (list: readonly T[]) => number {
  const found = new WeakMap<readonly T[], number>();
  const before = (list: readonly T[], end: number, stop: number): number => {
    for (let index = end - 1; index >= stop; index -= 1) if (matches(list[index] as T)) return index;
    return -1;
  };
  return (list) => {
    let last = found.get(list);
    if (last !== undefined) return last;
    const made = carriedFrom(list);
    const held = made ? found.get(made.prior as readonly T[]) : undefined;
    if (made && held !== undefined) {
      last = before(list, list.length, made.kept);
      // None among the entries read: the one found before stands if it was left in place.
      if (last < 0) last = held < made.kept ? held : before(list, made.kept, 0);
    } else {
      last = before(list, list.length, 0);
    }
    found.set(list, last);
    return last;
  };
}

/** Each value's first place in a list (each entry's `keyOf`, when given; an entry it gives undefined for has none), by
 *  the list. A list made from one already read (`noteCarried`) takes its places on: only the entries after the ones left
 *  in place are read, and the map is the same object, so it is asked for again with the list each time it is read. */
export function carriedFirsts<T, K = T>(keyOf?: (entry: T) => K | undefined): (list: readonly T[]) => ReadonlyMap<K, number> {
  const key = keyOf ?? ((entry: T) => entry as unknown as K);
  const indexes = new WeakMap<readonly T[], { list: readonly T[]; firsts: Map<K, number> }>();
  return (list) => {
    let index = indexes.get(list);
    if (index?.list === list) return index.firsts;
    const made = carriedFrom(list);
    const held = made ? indexes.get(made.prior as readonly T[]) : undefined;
    let from = 0;
    if (made && held?.list === made.prior) {
      index = held;
      from = made.kept;
      for (let at = from; at < held.list.length; at += 1) {
        const value = key(held.list[at] as T);
        if (value !== undefined && (held.firsts.get(value) ?? -1) >= from) held.firsts.delete(value);
      }
      index.list = list;
    } else {
      index = { list, firsts: new Map() };
    }
    for (let at = from; at < list.length; at += 1) {
      const value = key(list[at] as T);
      if (value !== undefined && !index.firsts.has(value)) index.firsts.set(value, at);
    }
    indexes.set(list, index);
    return index.firsts;
  };
}

/** A value read from a list in order, by the list. `read` takes the entries from `from` on into the state, `rewind` takes
 *  back what the entries from `from` on gave, and `result` makes the value (`held`: the one made for the list before). A
 *  list made from one already read (`noteCarried`) carries that list's state on from the entries it left in place. The
 *  state is never handed out: a value made for a list is that list's for good, whatever is read after it. */
export function carriedFold<T, S, R>(fold: {
  make(): S;
  rewind(state: S, from: number): void;
  read(state: S, list: readonly T[], from: number): void;
  result(state: S, list: readonly T[], held: R | undefined): R;
}): (list: readonly T[]) => R {
  type Slot = { list: readonly T[]; state: S; result: R | undefined };
  const slots = new WeakMap<readonly T[], Slot>();
  const results = new WeakMap<readonly T[], { value: R }>();
  return (list) => {
    const known = results.get(list);
    if (known) return known.value;
    const made = carriedFrom(list);
    const held = made ? slots.get(made.prior as readonly T[]) : undefined;
    let slot: Slot;
    let from = 0;
    if (made && held?.list === made.prior) {
      slot = held;
      from = made.kept;
      fold.rewind(slot.state, from);
    } else {
      slot = { list, state: fold.make(), result: undefined };
    }
    fold.read(slot.state, list, from);
    slot.list = list;
    const value = fold.result(slot.state, list, slot.result);
    slot.result = value;
    slots.set(list, slot);
    results.set(list, { value });
    return value;
  };
}

/** What the newest entry of each key says, by the list: `entryOf` gives an entry's key and what it says (undefined: it
 *  says nothing). A list carried on from one already read is read from the entries it did not keep, and its map is the
 *  one made before while those entries say nothing. */
export function carriedLatest<T, V>(
  entryOf: (entry: T, index: number) => readonly [key: string, value: V] | undefined
): (list: readonly T[]) => ReadonlyMap<string, V> {
  return carriedFold<T, { latest: CarriedFacts<string, V>; changed: boolean }, ReadonlyMap<string, V>>({
    make: () => ({ latest: new CarriedFacts(), changed: false }),
    rewind(state, from) {
      state.latest.rewind(from, () => {
        state.changed = true;
      });
    },
    read(state, list, from) {
      for (let index = from; index < list.length; index += 1) {
        const said = entryOf(list[index] as T, index);
        if (!said) continue;
        state.latest.set(index, said[0], said[1]);
        state.changed = true;
      }
    },
    result(state, _list, held) {
      if (held && !state.changed) return held;
      state.changed = false;
      return new Map(state.latest.entries());
    },
  });
}

/** Every bit of `value` spread over all of the result (MurmurHash3's finalizer): each value has a result of its own. */
function spread(value: number): number {
  let mixed = value | 0;
  mixed = Math.imul(mixed ^ (mixed >>> 16), 0x85ebca6b);
  mixed = Math.imul(mixed ^ (mixed >>> 13), 0xc2b2ae35);
  return (mixed ^ (mixed >>> 16)) | 0;
}

/** A hash of an entry made one of its place: a sum of these tells two orders of the same entries apart, with the odds of
 *  the hash itself. The entry's hash and its place are each spread before they meet and the pair is spread again, so two
 *  entries that trade places change the sum unless two unrelated 32-bit numbers happen to agree; one term still leaves
 *  or joins a sum in one step. */
export function placedHash(hash: number, index: number): number {
  return spread(spread(hash) + Math.imul(spread(index + 1), 0x9e3779b1));
}

/** FNV-1a of a string. */
export function textHash(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193);
  return hash | 0;
}

/** Facts folded from a list one entry at a time, each change remembered with the step that made it: the fold is taken back
 *  to any earlier step and carried on from there. */
export class CarriedFacts<K, V> {
  private readonly values = new Map<K, V>();
  private readonly steps: number[] = [];
  private readonly keys: K[] = [];
  private readonly had: boolean[] = [];
  private readonly before: (V | undefined)[] = [];

  get(key: K): V | undefined {
    return this.values.get(key);
  }

  has(key: K): boolean {
    return this.values.has(key);
  }

  get size(): number {
    return this.values.size;
  }

  entries(): IterableIterator<[K, V]> {
    return this.values.entries();
  }

  /** `key` holds `value` from step `at` on. */
  set(at: number, key: K, value: V): void {
    this.steps.push(at);
    this.keys.push(key);
    this.had.push(this.values.has(key));
    this.before.push(this.values.get(key));
    this.values.set(key, value);
  }

  /** Every change made at step `at` or later is undone, newest first. `undoing` is told each key before a change of it is
   *  undone, with the value it holds then: the first call for a key names the value it held before the rewind. */
  rewind(at: number, undoing?: (key: K, held: V | undefined) => void): void {
    while (this.steps.length > 0 && (this.steps.at(-1) as number) >= at) {
      this.steps.pop();
      const key = this.keys.pop() as K;
      const before = this.before.pop() as V;
      undoing?.(key, this.values.get(key));
      if (this.had.pop()) this.values.set(key, before);
      else this.values.delete(key);
    }
  }
}
