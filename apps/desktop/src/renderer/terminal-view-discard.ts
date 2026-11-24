interface DiscardableView {
  term: { element?: HTMLElement | undefined; dispose(): void };
  writer: { dispose(): void };
  localEcho: { reset(): void } | null;
}

/** A view no pane opened holds an empty xterm and nothing else worth keeping: release it. */
export function discardUnopenedView<V extends DiscardableView>(views: Map<string, V>, id: string, view: V): void {
  if (views.get(id) !== view || view.term.element) return;
  views.delete(id);
  view.localEcho?.reset();
  view.writer.dispose();
  try {
    view.term.dispose();
  } catch {
    /* never opened */
  }
}
