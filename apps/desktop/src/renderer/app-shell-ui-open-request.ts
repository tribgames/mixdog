import { useEffect, useRef } from 'react';
import type { Snapshot } from './desktop-types';
import {
  resolveDesktopSlashCommand,
  type CommandSurface as CommandSurfaceName,
  type SettingsSection as SlashSettingsSection,
} from './slash-commands';

const UI_OPEN_REQUEST_TTL_MS = 15_000;

interface UiOpenRequestProps {
  uiOpenRequest: Snapshot['uiOpenRequest'];
  sessionId: Snapshot['sessionId'];
  openConversationCommandSurface: (surface: CommandSurfaceName, sessionId?: string) => void;
  openSettings: (section?: SlashSettingsSection | null) => void;
}

export function useAppUiOpenRequest({
  uiOpenRequest,
  sessionId,
  openConversationCommandSurface,
  openSettings,
}: UiOpenRequestProps) {
  // Setup tool `open`: the engine publishes { command, seq } on the session
  // snapshot when the model asks for a settings surface. Route it exactly as
  // the typed slash command would (settings row, rail page, or command
  // surface); the seq guard makes a repeated identical request fire again.
  const uiOpenSeen = useRef(0);
  useEffect(() => {
    const request = uiOpenRequest;
    const seq = Number(request?.seq) || 0;
    if (!request?.command || seq <= uiOpenSeen.current) return;
    uiOpenSeen.current = seq;
    // A re-attached renderer replays the retained snapshot; a request older
    // than a few seconds is history, not an instruction.
    if (Number(request.at) > 0 && Date.now() - Number(request.at) > UI_OPEN_REQUEST_TTL_MS) return;
    const command = resolveDesktopSlashCommand(request.command);
    if (!command) return;
    if (command.surface) {
      openConversationCommandSurface(command.surface, sessionId || '');
      return;
    }
    if (command.settingsRow) openSettings(command.settingsRow);
    else if (command.action === 'settings') openSettings(null);
  }, [openConversationCommandSurface, openSettings, sessionId, uiOpenRequest]);
}
