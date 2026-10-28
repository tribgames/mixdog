/*
 * app/use-slash-palette.mjs — the slash / `$skill` palette above the prompt.
 *
 * useSlashPaletteState owns the selection index, the dismissed-draft marker
 * and the live open/count ref the mouse handler reads; it is declared early
 * because the mouse and draft hooks need the setters. useSlashPalette derives
 * the palette for this render from the prompt and the surfaces that suppress
 * it, publishes it to that ref, and keeps the index inside the list.
 */
import { useEffect, useRef, useState } from 'react';
import { deriveSlashPalette } from './slash-palette.mjs';
import { skillMentionQuery, useSkillMentionSkills } from './skill-mention-palette.mjs';

export function useSlashPaletteState() {
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashDismissedFor, setSlashDismissedFor] = useState('');
  const slashPaletteRef = useRef({ open: false, count: 0 });
  return { slashIndex, setSlashIndex, slashDismissedFor, setSlashDismissedFor, slashPaletteRef };
}

export function useSlashPalette({
  store,
  slashPaletteRef,
  setSlashIndex,
  slashDismissedFor,
  promptDraft,
  promptCaret,
  providerPrompt,
  settingsPrompt,
  toolApproval,
  contextPanel,
  usagePanel,
  picker,
  exiting,
  commandBusy,
}) {
  const mentionSkills = useSkillMentionSkills(store, skillMentionQuery(promptDraft, promptCaret) !== null);
  const palette = deriveSlashPalette({
    providerPrompt,
    settingsPrompt,
    toolApproval,
    contextPanel,
    usagePanel,
    picker,
    exiting,
    commandBusy,
    promptDraft,
    slashDismissedFor,
    skills: mentionSkills,
    promptCaret,
  });
  const { activeSlashQuery, slashCommands, slashPaletteOpen } = palette;
  slashPaletteRef.current = { open: slashPaletteOpen, count: slashCommands.length };

  // A query change re-clamps even when the list length stays the same.
  // biome-ignore lint/correctness/useExhaustiveDependencies(activeSlashQuery): query-change re-clamp trigger
  useEffect(() => {
    setSlashIndex((index) => Math.min(index, Math.max(0, slashCommands.length - 1)));
  }, [slashCommands.length, activeSlashQuery, setSlashIndex]);

  return palette;
}
