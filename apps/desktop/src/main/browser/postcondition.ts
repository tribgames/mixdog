export interface BrowserPostconditionInput {
  text?: string;
  textGone?: string;
  url?: string;
  timeoutMs?: number;
}

export interface BrowserPostcondition {
  text: string;
  textGone: string;
  url: string;
  timeoutMs: number;
}

export interface BrowserPostconditionState {
  /** Null means text was not observed, never an observed empty document. */
  text: string | null;
  url: string;
}

const DEFAULT_POSTCONDITION_TIMEOUT_MS = 5_000;
const MAX_POSTCONDITION_TIMEOUT_MS = 20_000;
const MAX_EXPLICIT_SETTLE_MS = 5_000;

function optionalString(value: unknown, name: string): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw new TypeError(`expect.${name} must be a string`);
  return value.trim();
}

export function normalizeBrowserPostcondition(raw: unknown): BrowserPostcondition | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError('expect must be an object');
  }
  const input = raw as BrowserPostconditionInput;
  const text = optionalString(input.text, 'text');
  const textGone = optionalString(input.textGone, 'textGone');
  const url = optionalString(input.url, 'url');
  if (!text && !textGone && !url) {
    throw new TypeError('expect requires text, textGone, and/or url');
  }
  if (input.timeoutMs !== undefined && !Number.isFinite(input.timeoutMs)) {
    throw new TypeError('expect.timeoutMs must be a finite number');
  }
  const timeoutMs = Math.min(
    MAX_POSTCONDITION_TIMEOUT_MS,
    Math.max(
      500,
      input.timeoutMs === undefined
        ? DEFAULT_POSTCONDITION_TIMEOUT_MS
        : Math.trunc(input.timeoutMs),
    ),
  );
  return { text, textGone, url, timeoutMs };
}

export function normalizeBrowserSettleMs(raw: unknown): number {
  if (raw === undefined || raw === null) return 0;
  if (!Number.isFinite(raw)) throw new TypeError('settleMs must be a finite number');
  return Math.min(MAX_EXPLICIT_SETTLE_MS, Math.max(0, Math.trunc(raw as number)));
}

export function browserPostconditionMatches(
  expected: Pick<BrowserPostconditionInput, 'text' | 'textGone' | 'url'>,
  state: BrowserPostconditionState,
): boolean {
  const text = state.text?.toLowerCase();
  const url = state.url.toLowerCase();
  return (!expected.text || (text !== undefined && text.includes(expected.text.toLowerCase())))
    && (!expected.textGone || (text !== undefined && !text.includes(expected.textGone.toLowerCase())))
    && (!expected.url || url.includes(expected.url.toLowerCase()));
}

export function describeBrowserPostcondition(
  expected: Pick<BrowserPostconditionInput, 'text' | 'textGone' | 'url'>,
): string {
  return [
    expected.text && `text ${JSON.stringify(expected.text)}`,
    expected.textGone && `textGone ${JSON.stringify(expected.textGone)}`,
    expected.url && `url ${JSON.stringify(expected.url)}`,
  ].filter(Boolean).join(' and ');
}
