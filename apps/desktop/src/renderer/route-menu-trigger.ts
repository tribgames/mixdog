/** The model trigger a route label stands in for: the one in the label's line
 *  (the one-line composer). Under the card the label opens its own menu. */
export function routeMenuTrigger(label: Element): HTMLElement | null {
  return label.closest('.composer-model-line')?.querySelector<HTMLElement>('.model-trigger') ?? null;
}
