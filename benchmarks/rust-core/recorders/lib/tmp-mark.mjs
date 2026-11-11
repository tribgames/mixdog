// Declared normalisation of the machine's temp root: in the string values at the paths `matches(path)` accepts (the system
// prompt text a session stores or sends), the OS temp dir (os.tmpdir(), as Node produced it, separators kept) becomes <TMP>.
// Nothing else is touched.
import { tmpdir } from 'node:os';

export const TMP_MARKER = '<TMP>';

export function markTmp(value, matches, path = []) {
  const root = tmpdir();
  if (typeof value === 'string') return matches(path) ? value.split(root).join(TMP_MARKER) : value;
  if (Array.isArray(value)) return value.map((item, index) => markTmp(item, matches, [...path, String(index)]));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, markTmp(item, matches, [...path, key])]));
  return value;
}
