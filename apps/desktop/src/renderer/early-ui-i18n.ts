/** Recovery and pairing run before i18next/React and must not wait for them.
 * boot.js carries a generated, small projection of the same UI catalogs. */
export function earlyUiT(key: string, options: Record<string, unknown> = {}): string {
  const translate = (globalThis as { bootT?: (key: string) => string }).bootT;
  const text = translate ? translate(key) : key;
  return text.replace(/\{\{(\w+)\}\}/g, (token, name: string) =>
    options[name] === undefined ? token : String(options[name]));
}
