// The live tag maps (tag -> sessionId / agent / cwd) shared by reference
// between the tag registry, the worker index and the terminal reaper. Every
// bind/unbind goes through here so the three maps never drift apart.
//
// Writers also set and delete the maps directly (worker-index bindTag), so the
// maps themselves report every change: `onChange(listener)` hears
// `(map, tag, previous, next)` for each set that changed a value and each
// delete of a present key, whoever made it (the status sets follow them).
// `tagSeq(tag)` is the tag's insertion order in `tags`, the order its entries
// iterate in.
class ObservedMap extends Map {
  constructor(name, emit, onInsert = null) {
    super();
    this.name = name;
    this.emit = emit;
    this.onInsert = onInsert;
  }

  set(key, value) {
    const had = super.has(key);
    const previous = had ? super.get(key) : undefined;
    super.set(key, value);
    if (!had) this.onInsert?.(key);
    if (!had || previous !== value) this.emit(this.name, key, previous, value);
    return this;
  }

  delete(key) {
    if (!super.has(key)) return false;
    const previous = super.get(key);
    super.delete(key);
    this.emit(this.name, key, previous, undefined);
    return true;
  }

  clear() {
    for (const key of [...super.keys()]) this.delete(key);
  }
}

export function createTagMaps() {
  const listeners = new Set();
  const emit = (name, tag, previous, next) => {
    for (const listener of listeners) listener(name, tag, previous, next);
  };
  const seqs = new Map();
  let seq = 0;
  const tags = new ObservedMap('tags', emit, (tag) => seqs.set(tag, ++seq));
  const tagAgents = new ObservedMap('agents', emit);
  const tagCwds = new ObservedMap('cwds', emit);
  listeners.add((name, tag, _previous, next) => {
    if (name === 'tags' && next === undefined) seqs.delete(tag);
  });
  const unbind = (tag) => {
    tags.delete(tag);
    tagAgents.delete(tag);
    tagCwds.delete(tag);
  };
  return {
    tags,
    tagAgents,
    tagCwds,
    /** `listener(map, tag, previous, next)`; `map` is 'tags' | 'agents' | 'cwds'. */
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    tagSeq: (tag) => seqs.get(tag) ?? Infinity,
    bind(tag, session) {
      tags.set(tag, session.id);
      if (session.agent) tagAgents.set(tag, session.agent);
      if (session.cwd) tagCwds.set(tag, session.cwd);
    },
    unbind,
    /** Drop the binding only while it still points at this session: a tag
     *  re-bound to newer work must survive the old session's cleanup. */
    unbindIfOwned(tag, sessionId) {
      if (tag && sessionId && tags.get(tag) === sessionId) unbind(tag);
    },
  };
}
