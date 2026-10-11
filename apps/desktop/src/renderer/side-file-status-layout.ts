/** Width ladder of the side file's footer. The path takes what is left;
 *  narrowing hides the language first, then the cursor. Problems counts always
 *  stay. */
export const SIDE_STATUS_PADDING = 12;
/** The footer has no path any more. */
export const SIDE_STATUS_PATH_MIN_WIDTH = 0;
export const SIDE_STATUS_PROBLEMS_WIDTH = 68;
export const SIDE_STATUS_CURSOR_WIDTH = 52;
export const SIDE_STATUS_LANGUAGE_WIDTH = 88;

export function sideStatusLayout(width: number): { cursor: boolean; language: boolean } {
  // Unmeasured row: show everything.
  if (width <= 0) return { cursor: true, language: true };
  const base = SIDE_STATUS_PADDING + SIDE_STATUS_PATH_MIN_WIDTH + SIDE_STATUS_PROBLEMS_WIDTH;
  const cursor = width >= base + SIDE_STATUS_CURSOR_WIDTH;
  // Language needs more room than the cursor, so it goes first.
  return { cursor, language: cursor && width >= base + SIDE_STATUS_CURSOR_WIDTH + SIDE_STATUS_LANGUAGE_WIDTH };
}
