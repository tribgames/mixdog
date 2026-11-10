/*
 * app/use-prompt-state.mjs — the prompt draft state and the refs App shares
 * between the prompt input, its handlers, the mouse handler and layout.
 */
import { useRef, useState } from 'react';

export function usePromptState() {
  const [promptDraft, setPromptDraft] = useState('');
  const [promptDraftOverride, setPromptDraftOverride] = useState(null);
  // The prompt caret offset as reported by PromptInput (null = end of draft);
  // the `$name` skill palette reads the mention before it.
  const [promptCaret, setPromptCaret] = useState(null);
  const promptLayoutValueRef = useRef('');
  const [, setPromptLayoutRows] = useState(1);
  const [textEntryLayoutRows, setTextEntryLayoutRows] = useState(1);
  const promptValueRef = useRef('');
  const promptSelectionRef = useRef(null);
  // [mixdog] Prompt-box mouse selection wiring. boxRect is the editable text
  // node's REAL absolute rect (top/left/height/contentWidth), reported by
  // PromptInput each render; mouseSelection exposes offsetAtCell/anchorAt/
  // extendTo/clear so the single mouse handler can drive the prompt's OWN
  // selectionAnchor engine without the ink-grid rect path.
  const promptBoxRectRef = useRef(null);
  const promptMouseSelectionRef = useRef(null);
  const promptHistoryNavRef = useRef({ active: false, index: -1, seed: '', lastValue: '' });
  const promptHistoryDraftChangeRef = useRef(false);
  return {
    promptDraft,
    setPromptDraft,
    promptDraftOverride,
    setPromptDraftOverride,
    promptCaret,
    setPromptCaret,
    promptLayoutValueRef,
    setPromptLayoutRows,
    textEntryLayoutRows,
    setTextEntryLayoutRows,
    promptValueRef,
    promptSelectionRef,
    promptBoxRectRef,
    promptMouseSelectionRef,
    promptHistoryNavRef,
    promptHistoryDraftChangeRef,
  };
}
