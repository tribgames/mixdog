// Slash-command and @-mention palettes: caret tracking, open/dismiss state,
// the debounced project-file search, and keyboard-selection scrolling.
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useMobileBack } from './mobile-back';
import { desktopComposerSlashCommands } from './slash-commands';
import type { ComposerSkill } from './composer-skill';
import { filterSkillMentions } from './composer-skill-mentions';
import { isInMarkdownCode } from '../../../../src/runtime/shared/skill-mentions.mjs';

type MentionMatch = { start: number; end: number; query: string };

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

/** A `$` skill mention being typed at the caret: the same openers as `@`
 *  (plus the backtick the shared parser accepts) and only skill-name
 *  characters after it, so `$HOME` or `@x$y` never open the skill palette.
 *  A `$` inside Markdown code (judged on the whole draft, as the runtime
 *  will) is never a mention, so the palette stays shut there. */
export function skillMentionMatchAt(draft: string, caretOffset: number): MentionMatch | null {
  const beforeCaret = draft.slice(0, Math.max(0, Math.min(caretOffset, draft.length)));
  const match = /(^|[\s([{"'`])\$([a-z0-9-]*)$/.exec(beforeCaret);
  if (!match) return null;
  const start = match.index + match[1].length;
  if (isInMarkdownCode(draft, start)) return null;
  return { start, end: beforeCaret.length, query: match[2] };
}

export function useComposerPalettes({
  draft,
  projectScope,
  paneActive,
  transitioning,
  composerFocused,
  selectorOpen,
  skills,
  room = false,
  plain = false,
}: {
  /** Agent mode: `/`, `@` files and `$` open nothing; the text is sent as typed. */
  plain?: boolean;
  draft: string;
  projectScope: string;
  paneActive: boolean;
  transitioning: boolean;
  composerFocused: boolean;
  selectorOpen: boolean;
  /** The user's enabled custom skills (built-ins are typed, not listed). */
  skills: ComposerSkill[];
  /** A group room's composer also lists /ask. */
  room?: boolean;
}) {
  const [caretOffset, setCaretOffset] = useState(0);
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState('');
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionResults, setMentionResults] = useState<string[]>([]);
  const [mentionLoading, setMentionLoading] = useState(false);
  const [mentionDismissed, setMentionDismissed] = useState('');
  const [skillIndex, setSkillIndex] = useState(0);
  const [skillDismissed, setSkillDismissed] = useState('');
  const slashPalette = useRef<HTMLDivElement>(null);
  const mentionPalette = useRef<HTMLDivElement>(null);
  const skillPalette = useRef<HTMLDivElement>(null);
  const mentionSearchGeneration = useRef(0);
  // Only frequent commands appear here; direct input still uses the full registry.
  const slashCommands = useMemo(() => desktopComposerSlashCommands(draft, room), [draft, room]);
  const slashOpen = Boolean(
    !plain &&
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
    !plain && composerFocused && projectScope && mentionMatch && !transitioning && mentionDismissed !== mentionSignature
  );
  // ABB: each open composer palette answers hardware back with the same
  // dismissal its own Escape performs.
  useMobileBack(slashOpen, () => setSlashDismissed(draft));
  useMobileBack(mentionOpen, () => setMentionDismissed(mentionSignature));
  const skillMatch = useMemo(() => skillMentionMatchAt(draft, caretOffset), [caretOffset, draft]);
  const skillSignature = skillMatch ? `${skillMatch.start}:${skillMatch.end}:${skillMatch.query}` : '';
  const skillResults = useMemo(
    () => (skillMatch ? filterSkillMentions(skills, skillMatch.query) : []),
    [skillMatch, skills]
  );
  // `@` and `$` never open together, and neither does `$` over the slash list
  // or the message selector.
  const skillOpen = Boolean(
    !plain &&
      composerFocused &&
      skillMatch &&
      !transitioning &&
      !slashOpen &&
      !mentionOpen &&
      !selectorOpen &&
      skillDismissed !== skillSignature
  );
  useMobileBack(skillOpen, () => setSkillDismissed(skillSignature));
  // biome-ignore lint/correctness/useExhaustiveDependencies: draft is the trigger that resets the highlighted slash row
  useEffect(() => setSlashIndex(0), [draft]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the mention query is the trigger that resets the highlighted row
  useEffect(() => setMentionIndex(0), [mentionMatch?.query]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the skill query is the trigger that resets the highlighted row
  useEffect(() => setSkillIndex(0), [skillMatch?.query]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: depends on the match's start/end/query fields, not on the match object identity (recomputed each draft change)
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
        .searchProjectFiles(projectScope, mentionMatch.query, 100, false, true)
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: slashIndex and slashCommands are the triggers that re-scroll the selected option into view
  useEffect(() => {
    if (slashOpen) scrollSelectedOptionIntoView(slashPalette);
  }, [slashIndex, slashOpen, slashCommands]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: mentionIndex and mentionResults are the triggers that re-scroll the selected option into view
  useEffect(() => {
    if (mentionOpen) scrollSelectedOptionIntoView(mentionPalette);
  }, [mentionIndex, mentionOpen, mentionResults]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: skillIndex and skillResults are the triggers that re-scroll the selected option into view
  useEffect(() => {
    if (skillOpen) scrollSelectedOptionIntoView(skillPalette);
  }, [skillIndex, skillOpen, skillResults]);
  const reset = useCallback(() => {
    setCaretOffset(0);
    setSlashIndex(0);
    setSlashDismissed('');
    setMentionIndex(0);
    setMentionResults([]);
    setMentionLoading(false);
    setMentionDismissed('');
    setSkillIndex(0);
    setSkillDismissed('');
  }, []);
  const invalidateSearch = useCallback(() => {
    mentionSearchGeneration.current += 1;
  }, []);
  let paletteId: string | undefined;
  if (slashOpen) paletteId = 'composer-slash-palette';
  else if (mentionOpen) paletteId = 'composer-mention-palette';
  else if (skillOpen) paletteId = 'composer-skill-mention-palette';
  let activeDescendant: string | undefined;
  if (slashOpen) activeDescendant = `composer-slash-option-${slashIndex}`;
  else if (mentionOpen && mentionResults.length) activeDescendant = `composer-mention-option-${mentionIndex}`;
  else if (skillOpen && skillResults.length) activeDescendant = `composer-skill-mention-option-${skillIndex}`;
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
    skillMention: {
      match: skillMatch,
      open: skillOpen,
      signature: skillSignature,
      results: skillResults,
      /** Whether any skill is selectable at all (empty-state copy). */
      available: skills.length > 0,
      index: skillIndex,
      dismissed: skillDismissed,
      setIndex: setSkillIndex,
      setDismissed: setSkillDismissed,
      palette: skillPalette,
    },
  };
}
