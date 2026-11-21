interface LoginDraft {
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

interface LoginSavePayload {
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
