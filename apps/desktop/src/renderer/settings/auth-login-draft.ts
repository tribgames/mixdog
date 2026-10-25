// The 로그인 추가 / 로그인 수정 dialog's save payload. The key rule: editing a
// login must not touch its stored authenticator key unless the user actually
// changed it (typed a new one) or explicitly removed it — otherwise the empty
// field would wipe a saved key on every edit.
export interface LoginDraft {
  /** Present when editing an existing login. */
  id?: string;
  site: string;
  username: string;
  /** Blank keeps the saved password when editing. */
  password: string;
  totpSecret: string;
  /** The user pressed "인증 키 삭제". */
  totpCleared: boolean;
  note: string;
}

export interface LoginSavePayload {
  id?: string;
  origin: string;
  username: string;
  password?: string;
  totpSecret?: string;
  note?: string;
}

export function loginSavePayload(draft: LoginDraft): LoginSavePayload {
  const host = draft.site.trim();
  const origin = /^https?:\/\//i.test(host) ? host : `https://${host}`;
  const totpValue = draft.totpCleared ? '' : draft.totpSecret.trim();
  // Send the key only on an explicit removal, or when a non-empty replacement
  // was entered. A field typed and then emptied (without 인증 키 삭제) omits it,
  // so a stored key is never silently wiped.
  const includeTotp = draft.totpCleared || totpValue !== '';
  return {
    ...(draft.id ? { id: draft.id } : {}),
    origin,
    username: draft.username.trim(),
    password: draft.password,
    ...(includeTotp ? { totpSecret: totpValue } : {}),
    note: draft.note,
  };
}
