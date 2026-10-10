// "Open in main tab" crosses two owners that never meet: the side browser pane
// (its own React root, owner of the page) asks, and the app shell (owner of the
// pane workspace) opens the main browser tab and folds the side panel.

export interface BrowserMainRequest {
  /** The conversation session whose side browser the page came from. */
  sessionId: string;
  url: string;
  title?: string;
}

type Listener = (request: BrowserMainRequest) => void;

const listeners = new Set<Listener>();

export function requestBrowserInMain(request: BrowserMainRequest): void {
  if (!request.sessionId || !request.url) return;
  for (const listener of listeners) listener(request);
}

export function onBrowserMainRequested(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
