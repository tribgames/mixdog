// A new agent's greeting ends with its reply suggestions in one HTML comment
// (invisible as markdown, dropped from previews):
//   <!-- mixdog:suggestions ["Show open PRs", "Change the interval"] -->
// The agent-mode transcript strips it and shows the suggestions as chips.

export const GREETING_SUGGESTIONS_MARK = 'mixdog:suggestions';
const MARK = /<!--\s*mixdog:suggestions\b([\s\S]*?)(?:-->|$)/;

/** The text without the suggestions comment (also an unfinished one while it
 *  streams), and its suggestions: up to three short strings. */
export function greetingSuggestions(text: unknown): { text: string; suggestions: string[]; marked: boolean } {
  const value = typeof text === 'string' ? text : '';
  const match = MARK.exec(value);
  if (!match) return { text: value, suggestions: [], marked: false };
  let suggestions: string[] = [];
  try {
    const parsed: unknown = JSON.parse(match[1].trim());
    if (Array.isArray(parsed)) {
      suggestions = parsed
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => entry.replace(/\s+/g, ' ').trim().slice(0, 80))
        .filter(Boolean)
        .slice(0, 3);
    }
  } catch {
    // Unfinished (still streaming) or malformed: no chips, the comment still hidden.
  }
  return { text: value.slice(0, match.index).trimEnd(), suggestions, marked: true };
}
