// Prompt-hint band, extracted from App.jsx. One transient hint line under the
// prompt (copy feedback, queue restore notices, slash argument hints) with a
// single auto-dismiss timer; the active/timer refs let key handlers decide
// whether a hint currently owns the band before clearing it.
import { useCallback, useEffect, useRef, useState } from 'react';

const PROMPT_HINT_DISMISS_MS = 2200;

export function usePromptHint() {
  const [promptHint, setPromptHint] = useState('');
  const [promptHintTone, setPromptHintTone] = useState('info');
  const promptHintTimerRef = useRef(null);
  const promptHintActiveRef = useRef(false);

  const showPromptHint = useCallback((text, tone = 'info', dismissMs = PROMPT_HINT_DISMISS_MS) => {
    if (promptHintTimerRef.current) clearTimeout(promptHintTimerRef.current);
    promptHintActiveRef.current = true;
    setPromptHint(String(text || ''));
    setPromptHintTone(tone);
    const timeoutMs = Number(dismissMs) > 0 ? Number(dismissMs) : PROMPT_HINT_DISMISS_MS;
    promptHintTimerRef.current = setTimeout(() => {
      promptHintTimerRef.current = null;
      promptHintActiveRef.current = false;
      setPromptHint('');
      setPromptHintTone('info');
    }, timeoutMs);
  }, []);

  // Same band and timer; only the resting tone differs for copy feedback.
  const showSelectionCopyHint = useCallback(
    (text, tone = 'plain') => showPromptHint(text, tone),
    [showPromptHint],
  );

  const clearPromptHint = useCallback(() => {
    if (!promptHintActiveRef.current && !promptHintTimerRef.current) return;
    if (promptHintTimerRef.current) {
      clearTimeout(promptHintTimerRef.current);
      promptHintTimerRef.current = null;
    }
    promptHintActiveRef.current = false;
    setPromptHint('');
    setPromptHintTone('info');
  }, []);

  useEffect(() => () => {
    if (promptHintTimerRef.current) clearTimeout(promptHintTimerRef.current);
  }, []);

  return {
    promptHint,
    promptHintTone,
    promptHintTimerRef,
    promptHintActiveRef,
    showPromptHint,
    showSelectionCopyHint,
    clearPromptHint,
  };
}
