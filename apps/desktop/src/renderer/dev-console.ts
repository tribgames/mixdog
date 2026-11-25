/** A trace line for the developer's console; a shipped build drops it. */
export function devInfo(line: string): void {
  if (import.meta.env?.DEV) console.info(line);
}
