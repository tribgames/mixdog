/**
 * One owner for the runtime-injected control blocks that must never reach a
 * user-facing surface (transcript rows, session titles, previews).
 *
 * TWO deliberate policies, because the sources differ:
 *
 *   - stripInjectedBlocks(text)
 *     Removes CLOSED blocks only. A lone OPENING tag is ordinary prose the
 *     user typed — "<system-reminder> 블록은 제어 컨텍스트다", "<available-deferred-tools>도
 *     따로 분류되어 있고 …". Swallowing it to end-of-string deleted the rest of
 *     that message from the desktop transcript while the stored history kept
 *     it in full (user report: 타이핑해서 엔터 넣으면 트랜스크립트에서 잘려 사라진다).
 *     Display surfaces therefore keep unterminated tags as text.
 *
 *   - stripInjectedBlocks(text, { dropUnterminated: true })
 *     Titles and previews run on TRUNCATED source, where a genuine injected
 *     block routinely loses its closing tag. There the tail is dropped so a
 *     reminder fragment can never name a session.
 */
export const INJECTED_DISPLAY_BLOCK_TAGS = Object.freeze([
  'system-reminder',
  'available-deferred-tools',
  'mcp-instructions',
  'memory-context',
  'skill',
  'event',
]);

export function stripInjectedBlocks(value, { dropUnterminated = false } = {}) {
  let text = String(value ?? '');
  for (const tag of INJECTED_DISPLAY_BLOCK_TAGS) {
    text = text.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}\\s*>`, 'gi'), ' ');
    if (dropUnterminated) text = text.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*$`, 'i'), ' ');
    // Orphan closing tags are always runtime residue, never authored text.
    text = text.replace(new RegExp(`<\\/${tag}\\s*>`, 'gi'), ' ');
  }
  return text;
}
