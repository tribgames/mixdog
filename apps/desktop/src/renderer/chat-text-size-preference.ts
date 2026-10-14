// "Chat text size" (Settings → Theme): a per-device renderer preference that
// scales ONLY the conversation (transcript) and the composer's typed text.
// Stored locally, never synced to the host. The scale lands on the root as
// --mx-chat-scale; 01-tokens.css re-declares the type tokens from it inside
// the conversation scope only, so app chrome keeps its size.
export type ChatTextSize = 'small' | 'default' | 'large' | 'extra-large';

const CHAT_TEXT_SIZE_KEY = 'mixdog.desktop.chat-text-size.v1';
const CHANGE_EVENT = 'mixdog:chat-text-size-changed';
export const CHAT_SCALE_PROPERTY = '--mx-chat-scale';

export const CHAT_TEXT_SCALES: Readonly<Record<ChatTextSize, number>> = {
  small: 0.9,
  default: 1,
  large: 1.15,
  'extra-large': 1.3,
};

let fallbackSize: ChatTextSize = 'default';
// A choice the storage refused: it outranks the older stored value for the
// rest of this renderer's life, so the pick still applies.
let unsavedSize: ChatTextSize | null = null;

function isChatTextSize(value: unknown): value is ChatTextSize {
  return typeof value === 'string' && Object.hasOwn(CHAT_TEXT_SCALES, value);
}

export function getChatTextSize(): ChatTextSize {
  if (unsavedSize) return unsavedSize;
  try {
    const stored = window.localStorage.getItem(CHAT_TEXT_SIZE_KEY);
    fallbackSize = isChatTextSize(stored) ? stored : fallbackSize;
  } catch {
    // Desktop-local preferences degrade to the in-memory value.
  }
  return fallbackSize;
}

export function getChatTextScale(): number {
  return CHAT_TEXT_SCALES[getChatTextSize()];
}

export function setChatTextSize(size: ChatTextSize): boolean {
  fallbackSize = size;
  let persisted = false;
  try {
    window.localStorage.setItem(CHAT_TEXT_SIZE_KEY, size);
    persisted = true;
  } catch {
    // The current renderer still applies the in-memory preference.
  }
  unsavedSize = persisted ? null : size;
  try {
    window.dispatchEvent(new window.Event(CHANGE_EVENT));
  } catch {
    // Non-browser imports keep the in-memory preference only.
  }
  return persisted;
}

export function subscribeChatTextSize(listener: () => void): () => void {
  const onChange = () => listener();
  window.addEventListener(CHANGE_EVENT, onChange);
  return () => window.removeEventListener(CHANGE_EVENT, onChange);
}

export function applyChatTextScale(): void {
  document.documentElement.style.setProperty(CHAT_SCALE_PROPERTY, String(getChatTextScale()));
}

/** Applies the stored scale before the first paint and on every change. */
export function installChatTextSize(): () => void {
  applyChatTextScale();
  return subscribeChatTextSize(applyChatTextScale);
}
