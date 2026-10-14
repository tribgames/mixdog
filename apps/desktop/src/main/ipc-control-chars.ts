const LAST_C0_CONTROL = 0x1f;
const DELETE_CONTROL = 0x7f;

/** True when `text` holds a C0 control character (U+0000-U+001F) or DEL (U+007F). */
export function hasControlCharacter(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code <= LAST_C0_CONTROL || code === DELETE_CONTROL) return true;
  }
  return false;
}
