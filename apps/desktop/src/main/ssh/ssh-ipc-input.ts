/** A renderer-supplied string argument that must be present. */
export function text(value: unknown, what: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`${what} must be a non-empty string.`);
  return value;
}
