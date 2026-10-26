// Slash-command and @-mention palettes: caret tracking, open/dismiss state,
// the debounced project-file search, and keyboard-selection scrolling.
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject, type SetStateAction } from 'react';
import { useMobileBack } from './mobile-back';
import { desktopComposerSlashCommands } from './slash-commands';
import type { ComposerSkill } from './composer-skill';
import { filterSkillMentions } from './composer-skill-mentions';
import { changedFilePaths, mentionedFilePaths, mentionItems, verifiedMentionedFiles } from './composer-mention-rows';
import { isInMarkdownCode } from '../../../../src/runtime/shared/skill-mentions.mjs';

type MentionMatch = { start: number; end: number; query: string };

/** How long the @-mention project-file search waits after the last keystroke. */
export const MENTION_SEARCH_DEBOUNCE_MS = 120;

/** Project search results, tagged with the project they were searched in. */
const EMPTY_SEARCH: { scope: string; paths: string[] } = { scope: '', paths: [] };

/** Recent files, tagged with the project they were read for. */
const EMPTY_RECENT: { scope: string; paths: { mentioned: string[]; changed: string[] } } = {
  scope: '',
  paths: { mentioned: [], changed: [] },
};

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
  userMessages,
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
  /** This conversation's user messages: files they `@`-mention head the `@` palette. */
  userMessages?: Array<{ id: string; text: string }>;
  /** A group room's composer also lists /ask. */
  room?: boolean;
}) {
  const [caretOffset, setCaretOffset] = useState(0);
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState('');
  const [mentionIndex, setMentionIndex] = useState(0);
  const [mentionSearch, setMentionSearch] = useState(EMPTY_SEARCH);
  // Rows searched in another project never show, even while this one searches;
  // the previous query's rows stay only within the same project.
  const mentionResults = mentionSearch.scope === projectScope ? mentionSearch.paths : EMPTY_SEARCH.paths;
  const setMentionResults = useCallback(
    (paths: string[]) => setMentionSearch({ scope: projectScope, paths }),
    [projectScope]
  );
  const [mentionLoading, setMentionLoading] = useState(false);
  const [mentionRecent, setMentionRecent] = useState(EMPTY_RECENT);
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
      setMentionSearch(EMPTY_SEARCH);
      setMentionLoading(false);
      return;
    }
    const generation = ++mentionSearchGeneration.current;
    // The previous query's rows stay until this one answers, so the list does
    // not collapse to the status line and grow back on every keystroke.
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
          setMentionSearch(EMPTY_SEARCH);
          setMentionLoading(false);
        });
    }, MENTION_SEARCH_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      if (mentionSearchGeneration.current === generation) mentionSearchGeneration.current += 1;
    };
  }, [mentionMatch?.end, mentionMatch?.query, mentionMatch?.start, mentionOpen, projectScope]);
  // The Recent files are read once per palette opening, not per keystroke: the
  // newest mentioned files that still exist in the project, and the files git
  // reports changed. A failed read only means no rows of that kind.
  const userMessagesRef = useRef(userMessages);
  userMessagesRef.current = userMessages;
  useEffect(() => {
    if (!mentionOpen) {
      setMentionRecent(EMPTY_RECENT);
      return;
    }
    let current = true;
    const mentioned = verifiedMentionedFiles(mentionedFilePaths(userMessagesRef.current || [], projectScope), (path) =>
      Promise.resolve().then(
        () => window.mixdogDesktop.statProjectFile?.(projectScope, path) ?? Promise.reject(new Error('no stat'))
      )
    );
    const changed = Promise.resolve()
      .then(() => window.mixdogDesktop.gitStatus?.(projectScope, { skipLineStats: true }))
      .then(
        (status) => changedFilePaths(status, projectScope),
        () => []
      );
    void Promise.all([mentioned, changed]).then(([mentionedPaths, changedPaths]) => {
      if (current)
        setMentionRecent({ scope: projectScope, paths: { mentioned: mentionedPaths, changed: changedPaths } });
    });
    return () => {
      current = false;
    };
  }, [mentionOpen, projectScope]);
  const mentionQuery = mentionMatch?.query || '';
  // Rows read for another project never show, even while this one's read is pending.
  const mentionRecentPaths = mentionRecent.scope === projectScope ? mentionRecent.paths : EMPTY_RECENT.paths;
  const mentionRows = useMemo(
    () =>
      mentionItems({
        mentioned: mentionRecentPaths.mentioned,
        changed: mentionRecentPaths.changed,
        results: mentionResults,
        query: mentionQuery,
      }),
    [mentionQuery, mentionRecentPaths, mentionResults]
  );
  // The highlighted row stays inside the combined list when it shrinks (a late
  // git read, a new answer): one value for rendering, aria and the keyboard.
  const mentionLast = Math.max(mentionRows.length - 1, 0);
  const mentionSelected = Math.min(mentionIndex, mentionLast);
  const mentionLastRef = useRef(mentionLast);
  mentionLastRef.current = mentionLast;
  const moveMentionIndex = useCallback((update: SetStateAction<number>) => {
    setMentionIndex((index) => {
      const selected = Math.min(index, mentionLastRef.current);
      return typeof update === 'function' ? update(selected) : update;
    });
  }, []);
  // An empty list keeps the user's place for when rows return.
  const mentionHasRows = mentionRows.length > 0;
  useEffect(() => {
    if (mentionHasRows) setMentionIndex((index) => Math.min(index, mentionLast));
  }, [mentionHasRows, mentionLast]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: slashIndex and slashCommands are the triggers that re-scroll the selected option into view
  useEffect(() => {
    if (slashOpen) scrollSelectedOptionIntoView(slashPalette);
  }, [slashIndex, slashOpen, slashCommands]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: mentionSelected and mentionRows are the triggers that re-scroll the selected option into view
  useEffect(() => {
    if (mentionOpen) scrollSelectedOptionIntoView(mentionPalette);
  }, [mentionSelected, mentionOpen, mentionRows]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: skillIndex and skillResults are the triggers that re-scroll the selected option into view
  useEffect(() => {
    if (skillOpen) scrollSelectedOptionIntoView(skillPalette);
  }, [skillIndex, skillOpen, skillResults]);
  const reset = useCallback(() => {
    setCaretOffset(0);
    setSlashIndex(0);
    setSlashDismissed('');
    setMentionIndex(0);
    setMentionSearch(EMPTY_SEARCH);
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
  else if (mentionOpen && mentionRows.length) activeDescendant = `composer-mention-option-${mentionSelected}`;
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
      /** Recent rows, then the search results not already among them. */
      items: mentionRows,
      loading: mentionLoading,
      index: mentionSelected,
      dismissed: mentionDismissed,
      setIndex: moveMentionIndex,
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
