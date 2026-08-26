export type UnknownRecord = Record<string, unknown>;

export function record(value: unknown): UnknownRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : {};
}

export function rows(value: unknown): UnknownRecord[] {
  return Array.isArray(value) ? value.map(record) : [];
}
