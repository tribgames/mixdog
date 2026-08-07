export type SettingsSection =
  | 'profile' | 'autoclear' | 'autocompact' | 'compact-type' | 'channels'
  | 'remote-runtime' | 'channel-provider' | 'channel-setting' | 'output-style'
  | 'theme' | 'workflow' | 'model' | 'search' | 'providers' | 'mcp'
  | 'plugins' | 'hooks' | 'skills' | 'update';

export type CommandSurface = 'context' | 'usage' | 'doctor';

export interface DesktopSlashCommand {
  name: string;
  usage: string;
  aliases?: readonly string[];
  aliasUsage?: readonly string[];
  showAliasUsage?: boolean;
  params?: string;
  description: string;
  settingsRow?: SettingsSection;
  surface?: CommandSurface;
  action?: 'clear' | 'compact' | 'resume' | 'remote';
}

// Public fields mirror src/tui/app/slash-commands.mjs, but the desktop keeps a
// deliberate SUBSET (user decision): typing a command must beat clicking. What
// survives is session-scoped turn control plus the read-only surfaces that own
// no page of their own. Everything with a permanent GUI home was dropped —
// effort/fast live in the model picker, agents in Workflows, and channels,
// hooks, skills, providers, theme, profile, update… in Settings.
export const SLASH_COMMANDS: ReadonlyArray<DesktopSlashCommand> = [
  { name: 'clear', usage: '/clear', aliases: ['new'], aliasUsage: ['new'], description: 'Start a fresh chat', action: 'clear' },
  { name: 'compact', usage: '/compact', description: 'Compact older conversation context', action: 'compact' },
  { name: 'resume', usage: '/resume', params: '[id]', description: 'Resume a saved chat', action: 'resume' },
  { name: 'context', usage: '/context', description: 'Show current context surface', surface: 'context' },
  { name: 'usage', usage: '/usage', params: '[refresh]', description: 'Show total provider quota / balance', surface: 'usage' },
  { name: 'model', usage: '/model', params: '[name|refresh]', description: 'Switch model for subsequent turns', settingsRow: 'model' },
  { name: 'remote', usage: '/remote', description: 'Claim remote for this session (takes over from any other session)', action: 'remote' },
  { name: 'doctor', usage: '/doctor', description: 'Diagnose installation health', surface: 'doctor' },
];
