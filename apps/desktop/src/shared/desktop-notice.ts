/** Desktop event (service → window) and IPC payload of a raised notice
 *  (src/runtime/shared/desktop-notice-host.mjs); the renderer words it. */
export const DESKTOP_NOTICE_EVENT = 'desktop-notice';

export const DESKTOP_NOTICE_CODES = [
  'provider-sign-in-expired',
  'connector-sign-in-expired',
  'secret-storage-failed',
  'conversation-save-failed',
] as const;
export type DesktopNoticeCode = (typeof DESKTOP_NOTICE_CODES)[number];

export interface DesktopNotice {
  /** One condition (e.g. `provider-sign-in:anthropic`): raised once until it changes. */
  key: string;
  code: DesktopNoticeCode;
  params: Record<string, string>;
}

/** A notice with a known code, or null. */
export function readDesktopNotice(value: unknown): DesktopNotice | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const code = DESKTOP_NOTICE_CODES.find((known) => known === record.code);
  if (!code || typeof record.key !== 'string' || !record.key) return null;
  const params: Record<string, string> = {};
  if (record.params && typeof record.params === 'object') {
    for (const [name, param] of Object.entries(record.params as Record<string, unknown>)) {
      if (typeof param === 'string') params[name] = param;
    }
  }
  return { key: record.key, code, params };
}
