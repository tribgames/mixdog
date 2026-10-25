// The browser pane's ⋯ "로그인 유지 중인 사이트" entry asks the app shell to
// open Settings › 인증 관리 (the old in-pane dialog is gone). App listens and
// calls openSettings('auth').
export const OPEN_AUTH_SETTINGS_EVENT = 'mixdog:open-auth-settings';

export function openAuthSettings(): void {
  window.dispatchEvent(new Event(OPEN_AUTH_SETTINGS_EVENT));
}
