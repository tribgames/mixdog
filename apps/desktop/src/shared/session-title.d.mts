export function stripSessionEnvelope(value: unknown): string;
export function stripInjectedDisplayText(value: unknown): string;
export function isSyntheticSessionDisplayText(value: unknown): boolean;
export function isGeneratedSessionTitleNoise(value: unknown): boolean;
export function normalizeSessionTitle(value: unknown, fallback?: string, maxLength?: number): string;
export function generatedSessionTitle(value: unknown, fallback?: string, maxLength?: number): string;
export function sessionSummaryTitle(
  session: { title?: string | null; preview?: string | null } | null | undefined,
  fallback?: string,
): string;
export function promptTitle(prompt: unknown, displayText?: string): string;
