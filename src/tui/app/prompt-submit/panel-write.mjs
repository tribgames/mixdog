/**
 * src/tui/app/prompt-submit/panel-write.mjs - one acknowledged daemon write
 * at a time per text-entry surface (provider / settings prompts): begin marks
 * the prompt submitting, finish closes it only while the write still owns the
 * surface, fail restores the typed value instead of losing it.
 */
import { isPanelEpochCurrent, supersedePanelEpoch } from '../panel-epoch.mjs';

// In-flight prompt writes, tracked at MODULE scope: createPromptSubmit is
// re-created on every render, so a closure flag resets mid-write and a second
// Enter starts an overlapping daemon write whose OLDER ack then closes the
// panel that already holds newer (restored) input. Each value is the panel
// epoch its write owns, so a write stops blocking the moment the user takes
// the surface back (Esc/close bumps the epoch).
const writeTokens = { provider: 0, settings: 0 };

export function createPanelWrite(surface, { store, setPrompt }) {
  const inFlight = () => writeTokens[surface] > 0 && isPanelEpochCurrent(writeTokens[surface]);
  const begin = (target) => {
    // A new submit supersedes every older in-flight write for this surface.
    const token = supersedePanelEpoch();
    writeTokens[surface] = token;
    setPrompt((prompt) => (prompt === target ? { ...prompt, submitting: true } : prompt));
    return token;
  };
  const end = (token) => {
    if (writeTokens[surface] === token) writeTokens[surface] = 0;
  };
  // Stale ack (newer submit, or the user closed the prompt): never close or
  // navigate a surface this write no longer owns.
  const finish = (token, after) => {
    end(token);
    if (!isPanelEpochCurrent(token)) return;
    setPrompt(null);
    after?.();
  };
  // A rejected daemon write keeps the prompt OPEN with the typed value
  // restored (the epoch remounts the editor, so an identical retry value
  // still re-seeds it) instead of closing and losing the entry.
  const fail = (target, value, message, token, tone = 'error') => {
    end(token);
    store.pushNotice(message, tone);
    if (!isPanelEpochCurrent(token)) return;
    // The restored panel now owns the surface.
    supersedePanelEpoch();
    setPrompt({
      ...target,
      submitting: false,
      initialValue: value,
      restoreEpoch: (Number(target.restoreEpoch) || 0) + 1,
    });
  };
  return { inFlight, begin, end, finish, fail };
}
