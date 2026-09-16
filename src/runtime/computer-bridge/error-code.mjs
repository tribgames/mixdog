/** Native and host errors share one category; details are never diagnostic keys. */
export function computerErrorCode(error) {
  const text = (error instanceof Error ? error.message : String(error ?? ''))
    .trim().replace(/^Error:\s*/i, '');
  return /^([a-z][a-z0-9_]{0,79})[:|]/i.exec(text)?.[1]?.toLowerCase() || '';
}
