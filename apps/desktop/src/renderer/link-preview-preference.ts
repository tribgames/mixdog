// "Link preview" (Settings → General): a renderer-side UI preference. ON, a
// file opened from a chat link lands in a preview tab that the next link
// replaces; OFF, every link opens a normal tab. Stored locally and announced
// to open panes so a change applies without a restart.
const LINK_PREVIEW_KEY = 'mixdog.desktop.link-preview.v1';
const CHANGE_EVENT = 'mixdog:link-preview-changed';
let fallbackEnabled = true;

export function getLinkPreview(): boolean {
  try {
    const stored = window.localStorage.getItem(LINK_PREVIEW_KEY);
    if (stored === 'on' || stored === 'off') fallbackEnabled = stored === 'on';
  } catch {
    // Desktop-local preferences degrade to the in-memory value.
  }
  return fallbackEnabled;
}

export function setLinkPreview(enabled: boolean): boolean {
  fallbackEnabled = enabled;
  let persisted = false;
  try {
    window.localStorage.setItem(LINK_PREVIEW_KEY, enabled ? 'on' : 'off');
    persisted = true;
  } catch {
    // The current renderer still applies the in-memory preference.
  }
  try {
    window.dispatchEvent(new window.Event(CHANGE_EVENT));
  } catch {
    // Non-browser imports keep the in-memory preference only.
  }
  return persisted;
}

export function subscribeLinkPreview(listener: () => void): () => void {
  const onChange = () => listener();
  window.addEventListener(CHANGE_EVENT, onChange);
  return () => window.removeEventListener(CHANGE_EVENT, onChange);
}

/** Main-tab open mode of a chat link where no side dock hosts files. */
export function chatLinkMainTabMode(linkPreview: boolean): 'preview' | 'pinned' {
  return linkPreview ? 'preview' : 'pinned';
}
