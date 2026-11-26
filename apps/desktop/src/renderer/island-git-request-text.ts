import type { IslandGitAction } from './island-git-request';

/** Leads the transcript text of a request: the user bubble is drawn as a card
 *  and the invisible marks keep the plain text readable on other surfaces. */
const MARK = '\u2063';
const ACTIONS = 'pr|commit-push|commit';
const REQUEST_PATTERN = new RegExp(`^${MARK}git-request:(${ACTIONS})${MARK}([^\\n]*)(?:\\n([^\\n]*))?`);
/** How the instructions after the card lines open. */
export const ISLAND_GIT_INSTRUCTIONS_HEAD = 'Island Git request: ';
/** A request's card lines, and its instructions to the end when the text is the prompt itself. */
const REQUEST_BLOCK = new RegExp(
  `^${MARK}git-request:(?:${ACTIONS})${MARK}[^\\n]*\\n[^\\n]*(?:\\n\\n${ISLAND_GIT_INSTRUCTIONS_HEAD}[\\s\\S]*)?\\n?`,
  'gm'
);

export function islandGitRequestDisplayText(action: IslandGitAction, label: string, meta: string): string {
  return `${MARK}git-request:${action}${MARK}${label}\n${meta}`;
}

/** The card's label and meta from a user message's transcript text. */
export function parseIslandGitRequestText(
  text: string
): { action: IslandGitAction; label: string; meta: string } | null {
  const match = REQUEST_PATTERN.exec(String(text || ''));
  if (!match) return null;
  return { action: match[1] as IslandGitAction, label: match[2].trim(), meta: (match[3] || '').trim() };
}

/** `text` without the island requests in it: a request is the app's message, never typed, so one handed
 *  back to a composer does not ride the message sent from it next. */
export function withoutIslandGitRequests(text: string): string {
  const kept = text.replace(REQUEST_BLOCK, '');
  return kept === text ? text : kept.trim();
}
