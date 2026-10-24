// Live registries of the elements that match a selector, kept from the DOM's
// own lifecycle instead of a document query per use. One mutation observer on
// <html> reports every mount and unmount (portals included: they mount under
// the same tree) and every flip of the attributes the selectors read; a
// registry scans only what was inserted, never the document again. Reading a
// registry first takes the observer's pending records, so the answer is
// current synchronously, also inside the event handler that just changed the
// DOM. The hot paths that used to query the whole document per keystroke or
// per frame (the keymap's modal check, the desktop pet's floating layers)
// read these instead: their cost follows the registered elements, not the
// size of the document (a hidden but mounted panel can hold ~50k nodes).

const FOLLOWING = 4; // Node.DOCUMENT_POSITION_FOLLOWING

interface Registry {
  selector: string;
  attributes: readonly string[];
  members: Set<Element>;
  /** Members in document order; null after a change until read again. */
  ordered: Element[] | null;
  listeners: Set<() => void>;
  /** Filled by one scan of the watched document (on its first read). */
  scanned: boolean;
}

export interface ElementRegistry {
  /** The connected elements that match, in document order (what
   *  `document.querySelectorAll(selector)` returns). */
  list(): readonly Element[];
  /** Calls `listener` when an element joins, leaves or moves; returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
}

const registries: Registry[] = [];
let watchedDocument: Document | null = null;
let observer: MutationObserver | null = null;
/** Every registry's selector in one list: one scan per inserted subtree. */
let anySelector = '';

function observe(): void {
  observer?.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: [...new Set(registries.flatMap((registry) => registry.attributes))],
  });
}

function changed(registry: Registry, touched: Set<Registry>): void {
  registry.ordered = null;
  touched.add(registry);
}

/** In the watched document's own tree: what `document.querySelectorAll`
 *  reaches. `isConnected` is not enough: a node moved into a shadow root or
 *  adopted by an iframe's document stays connected but leaves that tree. */
function inDocument(node: Node): boolean {
  return node.getRootNode() === watchedDocument;
}

/** Registers `element` (and the matches inside it) with every registry it
 *  matches: an inserted subtree, or a move (which can change the order). */
function admit(element: Element, touched: Set<Registry>): void {
  const hits = Array.from(element.querySelectorAll(anySelector));
  if (element.matches(anySelector)) hits.unshift(element);
  for (const hit of hits) {
    for (const registry of registries) {
      if (!hit.matches(registry.selector)) continue;
      registry.members.add(hit);
      changed(registry, touched);
    }
  }
}

function apply(records: MutationRecord[]): void {
  const touched = new Set<Registry>();
  let removed = false;
  /** Elements inserted in this batch; one scan of a subtree covers every
   *  insertion still inside it. */
  const added = new Set<Element>();
  for (const record of records) {
    if (record.type === 'attributes') {
      const target = record.target as Element;
      for (const registry of registries) {
        const matches = inDocument(target) && target.matches(registry.selector);
        if (matches === registry.members.has(target)) continue;
        if (matches) registry.members.add(target);
        else registry.members.delete(target);
        changed(registry, touched);
      }
      continue;
    }
    if (record.removedNodes.length) removed = true;
    for (const node of Array.from(record.addedNodes)) {
      if (node.nodeType === 1) added.add(node as Element);
    }
  }
  for (const element of added) {
    if (!inDocument(element)) continue;
    let ancestor = element.parentElement;
    while (ancestor && !added.has(ancestor)) ancestor = ancestor.parentElement;
    if (!ancestor) admit(element, touched);
  }
  if (removed) {
    for (const registry of registries) {
      for (const member of registry.members) {
        if (inDocument(member)) continue;
        registry.members.delete(member);
        changed(registry, touched);
      }
    }
  }
  for (const registry of touched) for (const listener of [...registry.listeners]) listener();
}

/** Brings every registry up to date: the pending records, then one scan for a
 *  registry not filled yet or a document not watched yet (the app has one
 *  document; tests install new ones). */
function sync(): void {
  if (watchedDocument === document && observer) {
    apply(observer.takeRecords());
  } else {
    observer?.disconnect();
    watchedDocument = document;
    observer = new window.MutationObserver(apply);
    for (const registry of registries) registry.scanned = false;
  }
  const fresh = registries.filter((registry) => !registry.scanned);
  if (!fresh.length) return;
  observe();
  for (const registry of fresh) {
    registry.members = new Set(document.querySelectorAll(registry.selector));
    registry.ordered = null;
    registry.scanned = true;
  }
}

/** A registry of the elements matching `selector`. The selector must depend
 *  only on the element's own `attributes` (class, role, aria-*: no
 *  combinators or state pseudo-classes), so their flips are the only changes
 *  besides mounts and unmounts. Creating one touches no DOM; the first read
 *  scans the document once. */
export function registerElements(selector: string, attributes: readonly string[]): ElementRegistry {
  const registry: Registry = {
    selector,
    attributes,
    members: new Set(),
    ordered: null,
    listeners: new Set(),
    scanned: false,
  };
  registries.push(registry);
  anySelector = registries.map((entry) => entry.selector).join(', ');
  return {
    list() {
      sync();
      registry.ordered ??= Array.from(registry.members).sort((a, b) =>
        a.compareDocumentPosition(b) & FOLLOWING ? -1 : 1
      );
      return registry.ordered;
    },
    subscribe(listener) {
      sync();
      registry.listeners.add(listener);
      return () => {
        registry.listeners.delete(listener);
      };
    },
  };
}
