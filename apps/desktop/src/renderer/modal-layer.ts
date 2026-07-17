type IsolationState = {
  owners: Set<number>;
  inert: boolean;
  ariaHidden: string | null;
};

const isolation = new WeakMap<HTMLElement, IsolationState>();
const stack: number[] = [];
const surfaces = new Map<number, HTMLElement>();
let sequence = 0;

export interface ModalLayerHandle {
  isTop(): boolean;
  attachSurface(element: HTMLElement | null): void;
  release(): void;
}

function refreshStacking() {
  stack.forEach((id, index) => {
    const surface = surfaces.get(id);
    if (surface) surface.style.zIndex = String(80 + index);
  });
}

/**
 * Coordinates modal ownership across independently portaled renderer surfaces.
 * Isolation is reference-counted per element and only restored while the
 * attributes still have the values assigned by this registry.
 */
export function acquireModalLayer(elements: Iterable<HTMLElement>): ModalLayerHandle {
  const id = ++sequence;
  const owned = Array.from(new Set(elements));
  let released = false;
  stack.push(id);

  for (const element of owned) {
    let state = isolation.get(element);
    if (!state) {
      state = {
        owners: new Set(),
        inert: element.inert,
        ariaHidden: element.getAttribute("aria-hidden"),
      };
      isolation.set(element, state);
    }
    state.owners.add(id);
    element.inert = true;
    element.setAttribute("aria-hidden", "true");
  }

  return {
    isTop: () => !released && stack.at(-1) === id,
    attachSurface(element) {
      if (released) return;
      if (element) surfaces.set(id, element);
      else surfaces.delete(id);
      refreshStacking();
    },
    release() {
      if (released) return;
      released = true;
      const index = stack.lastIndexOf(id);
      if (index >= 0) stack.splice(index, 1);
      surfaces.delete(id);
      refreshStacking();
      for (const element of owned) {
        const state = isolation.get(element);
        if (!state) continue;
        state.owners.delete(id);
        if (state.owners.size > 0) continue;
        isolation.delete(element);
        if (element.inert === true) element.inert = state.inert;
        if (element.getAttribute("aria-hidden") === "true") {
          if (state.ariaHidden == null) element.removeAttribute("aria-hidden");
          else element.setAttribute("aria-hidden", state.ariaHidden);
        }
      }
    },
  };
}
