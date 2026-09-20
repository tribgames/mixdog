// Slash-command and @-mention palettes: caret tracking, open/dismiss state,
// the debounced project-file search, and keyboard-selection scrolling.
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useMobileBack } from './mobile-back';
import { desktopComposerSlashCommands } from './slash-commands';

export type MentionMatch = { start: number; end: number; query: string };

export function scrollSelectedOptionIntoView(panel: RefObject<HTMLDivElement | null>) {
  panel.current
    ?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]')
    ?.scrollIntoView?.({ block: 'nearest' });
}

function mentionMatchAt(draft: string, caretOffset: number): MentionMatch | null {
  const beforeCaret = draft.slice(0, Math.max(0, Math.min(caretOffset, draft.length)));
  const match = /(^|[\s([{"'])@([^\s@]*)$/.exec(beforeCaret);
  if (!match) return null;
  const start = match.index + match[1].length;
  return { start, end: beforeCaret.length, query: match[2] || '' };
}

export function useComposerPalettes({
  draft,
  projectScope,
  paneActive,
  transitioning,
  composerFocused,
  selectorOpen,
}: {
  draft: string;
  projectScope: string;
  paneActive: boolean;
  transitioning: boolean;
  composerFocused: boolean;
  selectorOpen: boolean;
}) {
  const [caretOffset, setCaretOffset] = useState(0);
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState('');
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionResults, setMentionResults] = useState<string[]>([]);
  const [mentionLoading, setMentionLoading] = useState(false);
  const [mentionDismissed, setMentionDismissed] = useState('');
  const slashPalette = useRef<HTMLDivElement>(null);
  const mentionPalette = useRef<HTMLDivElement>(null);
  const mentionSearchGeneration = useRef(0);
  // Only frequent commands appear here; direct input still uses the full registry.
  const slashCommands = useMemo(() => desktopComposerSlashCommands(draft), [draft]);
  const slashOpen = Boolean(
    composerFocused &&
      paneActive &&
      !selectorOpen &&
      !transitioning &&
      caretOffset === draft.length &&
      slashDismissed !== draft &&
      slashCommands.length
  );
  const mentionMatch = useMemo(() => mentionMatchAt(draft, caretOffset), [caretOffset, draft]);
  const mentionSignature = mentionMatch ? `${mentionMatch.start}:${mentionMatch.end}:${mentionMatch.query}` : '';
  const mentionOpen = Boolean(
    composerFocused && projectScope && mentionMatch && !transitioning && mentionDismissed !== mentionSignature
  );
  // ABB: each open composer palette answers hardware back with the same
  // dismissal its own Escape performs.
  useMobileBack(slashOpen, () => setSlashDismissed(draft));
  useMobileBack(mentionOpen, () => setMentionDismissed(mentionSignature));
  useEffect(() => setSlashIndex(0), [draft]);
  useEffect(() => setMentionIndex(0), [mentionMatch?.query]);
  useEffect(() => {
    if (!mentionOpen || !mentionMatch) {
      mentionSearchGeneration.current += 1;
      setMentionResults([]);
      setMentionLoading(false);
      return;
    }
    const generation = ++mentionSearchGeneration.current;
    setMentionResults([]);
    setMentionLoading(true);
    const timer = window.setTimeout(() => {
      void window.mixdogDesktop
        .searchProjectFiles(projectScope, mentionMatch.query, 20)
        .then((paths) => {
          if (mentionSearchGeneration.current !== generation) return;
          setMentionResults(paths);
          setMentionLoading(false);
        })
        .catch(() => {
          if (mentionSearchGeneration.current !== generation) return;
          setMentionResults([]);
          setMentionLoading(false);
        });
    }, 120);
    return () => {
      window.clearTimeout(timer);
      if (mentionSearchGeneration.current === generation) mentionSearchGeneration.current += 1;
    };
  }, [mentionMatch?.end, mentionMatch?.query, mentionMatch?.start, mentionOpen, projectScope]);
  useEffect(() => {
    if (slashOpen) scrollSelectedOptionIntoView(slashPalette);
  }, [slashIndex, slashOpen, slashCommands]);
  useEffect(() => {
    if (mentionOpen) scrollSelectedOptionIntoView(mentionPalette);
  }, [mentionIndex, mentionOpen, mentionResults]);
  const reset = useCallback(() => {
    setCaretOffset(0);
    setSlashIndex(0);
    setSlashDismissed('');
    setMentionIndex(0);
    setMentionResults([]);
    setMentionLoading(false);
    setMentionDismissed('');
  }, []);
  const invalidateSearch = useCallback(() => {
    mentionSearchGeneration.current += 1;
  }, []);
  let paletteId: string | undefined;
  if (slashOpen) paletteId = 'composer-slash-palette';
  else if (mentionOpen) paletteId = 'composer-mention-palette';
  let activeDescendant: string | undefined;
  if (slashOpen) activeDescendant = `composer-slash-option-${slashIndex}`;
  else if (mentionOpen && mentionResults.length) activeDescendant = `composer-mention-option-${mentionIndex}`;
  return {
    caretOffset,
    setCaretOffset,
    paletteId,
    activeDescendant,
    reset,
    invalidateSearch,
    slash: {
      open: slashOpen,
      commands: slashCommands,
      index: slashIndex,
      setIndex: setSlashIndex,
      dismissed: slashDismissed,
      setDismissed: setSlashDismissed,
      palette: slashPalette,
    },
    mention: {
      match: mentionMatch,
      open: mentionOpen,
      signature: mentionSignature,
      results: mentionResults,
      loading: mentionLoading,
      index: mentionIndex,
      dismissed: mentionDismissed,
      setIndex: setMentionIndex,
      setDismissed: setMentionDismissed,
      setResults: setMentionResults,
      palette: mentionPalette,
    },
  };
}
