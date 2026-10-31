// "Composer style" (Settings → Display → Composer): a per-device renderer
// preference for how much the composer shows. simple: the model only; basic
// ("Normal"): the usage readout too; detail (default): the readout and the
// conversation's workflow and delegation.
export const COMPOSER_STYLES = ['simple', 'basic', 'detail'] as const;
export type ComposerStyle = (typeof COMPOSER_STYLES)[number];

const STYLE_KEY = 'mixdog.desktop.composer-style.v1';
// The earlier "Show workflow and delegation" switch, cleared on the first save.
const LEGACY_ROUTE_LABEL_KEY = 'mixdog.desktop.route-label.v1';
const CHANGE_EVENT = 'mixdog:composer-style-changed';
let fallbackStyle: ComposerStyle = 'detail';

function isStyle(value: unknown): value is ComposerStyle {
  return COMPOSER_STYLES.includes(value as ComposerStyle);
}

export function getComposerStyle(): ComposerStyle {
  try {
    const stored = window.localStorage.getItem(STYLE_KEY);
    if (isStyle(stored)) fallbackStyle = stored;
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
