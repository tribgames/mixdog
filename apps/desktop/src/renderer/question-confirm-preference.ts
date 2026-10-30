// "Confirm question answers" (Settings → Display): a per-device renderer
// preference. ON, picking a single-choice option only selects it and the
// Next/Send button (or Enter) submits; OFF, the pick itself answers. Stored
// locally so a phone can confirm while the PC keeps one-tap answers.
const QUESTION_CONFIRM_KEY = 'mixdog.desktop.question-confirm.v1';
const CHANGE_EVENT = 'mixdog:question-confirm-changed';
let fallbackEnabled = false;

export function getQuestionConfirm(): boolean {
  try {
    const stored = window.localStorage.getItem(QUESTION_CONFIRM_KEY);
    if (stored === 'on' || stored === 'off') fallbackEnabled = stored === 'on';
  } catch {
    // Desktop-local preferences degrade to the in-memory value.
  }
  return fallbackEnabled;
}

export function setQuestionConfirm(enabled: boolean): boolean {
  fallbackEnabled = enabled;
  let persisted = false;
  try {
    window.localStorage.setItem(QUESTION_CONFIRM_KEY, enabled ? 'on' : 'off');
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

export function subscribeQuestionConfirm(listener: () => void): () => void {
  const onChange = () => listener();
  window.addEventListener(CHANGE_EVENT, onChange);
  return () => window.removeEventListener(CHANGE_EVENT, onChange);
}
