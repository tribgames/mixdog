// prompt-handlers/use-prompt-history-nav.mjs
// handlePromptHistoryNavigate: applies one history step to the navigation ref,
// the draft-change flag and the prompt hint.
import { useCallback } from 'react';
import { navigatePromptHistory } from './history-navigation.mjs';

export function usePromptHistoryNavigation({
  promptHistoryNavRef,
  promptHistoryDraftChangeRef,
  recentPromptHistory,
  resetPromptHistoryNav,
  clearPromptHint,
}) {
  return useCallback(
    (direction, currentText = '', meta = {}) => {
      const outcome = navigatePromptHistory({
        direction,
        currentText,
        meta,
        nav: promptHistoryNavRef.current,
        history: recentPromptHistory,
      });
      if (outcome.reset) resetPromptHistoryNav();
      if (outcome.nav) promptHistoryNavRef.current = outcome.nav;
      clearPromptHint();
      if (outcome.draftChanged) promptHistoryDraftChangeRef.current = true;
      return outcome.value;
    },
    [recentPromptHistory, resetPromptHistoryNav, clearPromptHint]
  );
}
