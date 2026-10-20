import { openModal } from './settings/dialog-modality';

const stack: number[] = [];
const surfaces = new Map<number, HTMLElement>();
let sequence = 0;

interface ModalLayerHandle {
  isTop(): boolean;
  attachSurface(element: HTMLElement | null): void;
  release(): void;
}

function refreshStacking() {
  stack.forEach((id, index) => {
    const surface = surfaces.get(id);
    // Base 960: above every static dialog card (schedules/agent editors sit
    // at CSS 940, the studio model panel at 950) so a picker opened FROM a
    // dialog paints over it (user: 팝업에서 모델 누르면 아무것도 안 뜬다),
    // while toasts (1000) and tooltips (1200) stay above modal chrome.
    if (surface) surface.style.zIndex = String(960 + index);
  });
}

/**
 * Coordinates stacking across independently portaled renderer surfaces. Page
 * isolation is not done here: a layer that isolates (a non-empty `elements`)
 * registers its surface with the one modality owner, settings/dialog-modality,
 * which alone sets and restores `inert` for every modal kind.
 */
export function acquireModalLayer(elements: Iterable<HTMLElement>): ModalLayerHandle {
  const id = ++sequence;
  const isolates = Array.from(elements).length > 0;
  let released = false;
  let closeModal: (() => void) | null = null;
  stack.push(id);

  return {
    isTop: () => !released && stack.at(-1) === id,
    attachSurface(element) {
      if (released) return;
      if (element) surfaces.set(id, element);
      else surfaces.delete(id);
      closeModal?.();
      closeModal = isolates && element ? openModal(element) : null;
      refreshStacking();
    },
    release() {
      if (released) return;
      released = true;
      const index = stack.lastIndexOf(id);
      if (index >= 0) stack.splice(index, 1);
      surfaces.delete(id);
      refreshStacking();
      closeModal?.();
      closeModal = null;
    },
  };
}
