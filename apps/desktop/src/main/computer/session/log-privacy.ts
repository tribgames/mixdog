/** Diagnostics retain categories, never arbitrary provider or launch payloads. */
export function computerLogTarget(value: string): string {
  const target = value.trim();
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) && !/^[a-z]:[\\/]/i.test(target)) {
    try {
      const url = new URL(target);
      return url.protocol === 'http:' || url.protocol === 'https:'
        ? `${url.protocol}//${url.host}/`
        : `${url.protocol}[redacted]`;
    } catch {
      return '[redacted-url]';
    }
  }
  return (target.split(/[\\/]/).pop() || '').slice(0, 128);
}

export function computerLogError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return /^([a-z][a-z0-9_]{0,79}):/.exec(message)?.[1] || 'computer_command_failed';
}
