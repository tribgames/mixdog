/** Human-readable text of a thrown value: an Error's non-empty message, else a non-empty string `message` property, else the value itself when a string, else its `String()` form. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string') return error;
  if (typeof error === 'object' && error !== null) {
    const { message } = error as { message?: unknown };
    if (typeof message === 'string' && message) return message;
  }
  return String(error);
}
