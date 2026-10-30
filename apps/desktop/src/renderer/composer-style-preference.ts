// "Composer style" (Settings → Display → Composer): a per-device renderer
// preference for how much the composer shows. simple: the two-row card from
// the start, nothing under it; basic (default): the usage readout under the
// composer; detail: the readout and the conversation's workflow and delegation.
export type ComposerStyle = 'simple' | 'basic' | 'detail';

const STYLE_KEY = 'mixdog.desktop.composer-style.v1';
// The earlier "Show workflow and delegation" switch: a device that turned it
// on starts on "detail".
const LEGACY_ROUTE_LABEL_KEY = 'mixdog.desktop.route-label.v1';
const CHANGE_EVENT = 'mixdog:composer-style-changed';
let fallbackStyle: ComposerStyle = 'basic';

function isStyle(value: unknown): value is ComposerStyle {
  return value === 'simple' || value === 'basic' || value === 'detail';
}

export function getComposerStyle(): ComposerStyle {
  try {
    const stored = window.localStorage.getItem(STYLE_KEY);
    if (isStyle(stored)) fallbackStyle = stored;
    else if (window.localStorage.getItem(LEGACY_ROUTE_LABEL_KEY) === 'on') fallbackStyle = 'detail';
  } catch {
    // Desktop-local preferences degrade to the in-memory value.
  }
  return fallbackStyle;
}

export function setComposerStyle(style: ComposerStyle): boolean {
  fallbackStyle = style;
  let persisted = false;
  try {
    window.localStorage.setItem(STYLE_KEY, style);
    window.localStorage.removeItem(LEGACY_ROUTE_LABEL_KEY);
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

export function subscribeComposerStyle(listener: () => void): () => void {
  const onChange = () => listener();
  window.addEventListener(CHANGE_EVENT, onChange);
  return () => window.removeEventListener(CHANGE_EVENT, onChange);
}
