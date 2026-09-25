/** A bounded snake_case category (an error code, a path, a stage); anything
 *  else could carry provider or user text into persisted diagnostics. */
export function diagnosticCategory(value: unknown): string | undefined {
  return typeof value === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(value) ? value : undefined;
}
