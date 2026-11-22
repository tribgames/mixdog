/** Work a live reply does per update, counted where it is done: what one word
 *  costs can then be compared behind a short and a long finished prefix. */
export const markdownWorkCounts = {
  /** Block boundaries the splitter looked at. */
  splitterBoundaries: 0,
  /** Block entries parking looked at. */
  parkingEntries: 0,
};

export function resetMarkdownWorkCounts(): void {
  markdownWorkCounts.splitterBoundaries = 0;
  markdownWorkCounts.parkingEntries = 0;
}
