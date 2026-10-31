import { useLayoutEffect, useState, type RefObject } from 'react';

/** Free width the one-line layout needs beyond its items before the card gives
 *  the line back; without it a width on the boundary would flip every resize. */
export const CARD_RETURN_ROOM = 24;
// The route label's divider: 1px plus its 2px margins.
const ROUTE_DIVIDER = 5;

/** Whether the card is wanted: it takes over once the one-line layout's items
 *  (`required`, natural widths) outgrow the line, and gives it back once they
 *  fit with CARD_RETURN_ROOM to spare. */
export function wantsCard(required: number, available: number, card: boolean): boolean {
  return required + (card ? CARD_RETURN_ROOM : 0) > available;
}

const width = (element: Element | null | undefined) => element?.getBoundingClientRect().width ?? 0;

/** The model pill and gauge at their natural width, a label an ellipsis cut
 *  counted in full. The route label and its divider are counted apart. */
function modelControlsWidth(controls: Element | null | undefined): number {
  const modelLabel = controls?.querySelector('.model-route-label');
  let total = 0;
  for (const child of Array.from(controls?.children ?? [])) {
    if (!child.matches('.composer-route-label, .composer-route-divider')) total += width(child);
  }
  return total + Math.max(0, (modelLabel?.scrollWidth ?? 0) - (modelLabel?.clientWidth ?? 0));
}

/** The one-line layout's items at their natural width, wherever the card or the
 *  line holds them now: the worded usage readout (its data-full-width) or, before
 *  the first message, the pickers in its place (they shrink, so their content
 *  width), the route label with its workflow name, and the model with its
 *  effort label (a label an ellipsis cut counts in full). */
function oneLineItemsWidth(form: HTMLElement, line: HTMLElement): number {
  const readout = line.querySelector<HTMLElement>(':scope > .composer-usage-readout');
  const pickers = line.querySelector(':scope > .composer-model-line-context');
  const label = line.querySelector('.composer-route-label');
  const controls =
    form.querySelector('.composer-model-line-controls') ?? line.querySelector('.composer-model-line-controls');
  return (
    Number(readout?.dataset.fullWidth ?? 0) +
    (pickers?.scrollWidth ?? 0) +
    (label ? width(label) + ROUTE_DIVIDER : 0) +
    modelControlsWidth(controls)
  );
}

// The line's side padding (`.composer-model-line`), for the card of the "simple"
// style, which has no line under it to measure: the form is as wide as it would be.
const LINE_PADDING = 16;

/** Whether a PC composer's one-line layout cannot show every item in full, so
 *  the card (Composer.tsx) is the layout. Measured from the items' natural
 *  widths in either layout, so the answer does not depend on the layout shown. */
export function useOneLineOverflow(form: RefObject<HTMLElement | null>, active: boolean): boolean {
  const [overflow, setOverflow] = useState(false);
  // `overflow` re-binds the observers: the line under the card comes and goes
  // with it, and its content changes are watched too.
  useLayoutEffect(() => {
    const element = form.current;
    if (!active || !element) return undefined;
    const lineOf = () => {
      const next = element.nextElementSibling as HTMLElement | null;
      return next?.matches('.composer-model-line') ? next : null;
    };
    const measure = () => {
      const line = lineOf();
      let available = element.clientWidth - LINE_PADDING;
      if (line) {
        const style = window.getComputedStyle(line);
        available = line.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight);
      }
      setOverflow((card) => wantsCard(oneLineItemsWidth(element, line ?? element), available, card));
    };
    measure();
    const line = lineOf();
    // The form exists in every layout and is as wide as the line, so a line
    // that comes or goes never orphans the resize observation.
    const resize = new ResizeObserver(measure);
    resize.observe(element);
    if (line) resize.observe(line);
    // The model, effort, workflow or readout figures change a width without
    // resizing the line; the controls also move between the card's row and the line.
    const mutation = new MutationObserver(measure);
    const footer = element.querySelector('.composer-footer');
    for (const root of [footer, line]) {
      if (root)
        mutation.observe(root, {
          childList: true,
          subtree: true,
          characterData: true,
          attributes: true,
          attributeFilter: ['data-full-width'],
        });
    }
    document.fonts?.addEventListener('loadingdone', measure);
    return () => {
      resize.disconnect();
      mutation.disconnect();
      document.fonts?.removeEventListener('loadingdone', measure);
    };
  }, [form, active, overflow]);
  return active && overflow;
}
