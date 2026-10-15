/*
 * app/slash-palette.mjs — which slash palette (if any) the prompt draft opens.
 */
import { SLASH_COMMANDS, slashQuery, slashCommandMatches, compareSlashCommands } from './slash-commands.mjs';
import { skillMentionItems, skillMentionQuery } from './skill-mention-palette.mjs';

export function deriveSlashPalette({
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
  skills = [],
  promptCaret = null,
}) {
  const activeSlashQuery =
    providerPrompt || settingsPrompt || toolApproval || contextPanel || usagePanel ? null : slashQuery(promptDraft);
  const surfaceFree = !picker && !toolApproval && !contextPanel && !usagePanel && !exiting && !commandBusy;
  // "Slash mode" is live whenever a /token is being edited and no other
  // surface owns the floating area. The palette stays OPEN for the whole
  // slash session — including 0-match frames — so its 14-row layout never
  // unmounts/remounts per keystroke (fullscreen repaint flicker fix).
  const slashModeLive = activeSlashQuery !== null && surfaceFree;
  if (!slashModeLive) {
    // `$name` completion shares the palette, but opens only while a skill
    // matches: `$HOME` or `$300` in prose must not raise a panel.
    const mention =
      surfaceFree && !providerPrompt && !settingsPrompt ? skillMentionQuery(promptDraft, promptCaret) : null;
    const slashCommands = mention ? skillMentionItems(skills, mention.query) : [];
    return {
      activeSlashQuery: mention ? mention.query : null,
      slashCommands,
      slashPaletteOpen: slashCommands.length > 0 && slashDismissedFor !== promptDraft,
      paletteKind: mention ? 'skills' : 'commands',
    };
  }
  const slashCommands = SLASH_COMMANDS.filter((command) => slashCommandMatches(command, activeSlashQuery)).sort(
    compareSlashCommands
  );
  const slashPaletteOpen = slashDismissedFor !== promptDraft;
  return { activeSlashQuery, slashCommands, slashPaletteOpen, paletteKind: 'commands' };
}
