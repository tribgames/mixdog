/** Diagnostics retain categories, never arbitrary provider or launch payloads. */
import { computerErrorCode } from '../../../../../../src/runtime/computer-bridge/error-code.mjs';

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
  return computerErrorCode(error) || 'computer_command_failed';
}
