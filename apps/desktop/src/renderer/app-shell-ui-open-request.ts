import { useEffect, useRef } from 'react';
import type { Snapshot } from './desktop-types';
import {
  resolveDesktopSlashCommand,
  type CommandSurface as CommandSurfaceName,
  type SettingsSection as SlashSettingsSection,
} from './slash-commands';

const UI_OPEN_REQUEST_TTL_MS = 15_000;

// Setup `open` targets that are settings sections without a slash command
// (SETUP_SECTION_OPEN_TARGETS in the runtime setup tool).
const SETUP_SECTION_TARGETS: Readonly<Record<string, SlashSettingsSection>> = {
  developer: 'developer',
  voice: 'voice',
  connection: 'connection',
};

/** Session-lane publications, already limited by the caller to the sessions
 *  this window shows. */
export type SetupLaneSource = (listener: (update: { sessionId: string; snapshot: unknown }) => void) => () => void;

interface UiOpenRequestProps {
  uiOpenRequest: Snapshot['uiOpenRequest'];
  sessionId: Snapshot['sessionId'];
  openConversationCommandSurface: (surface: CommandSurfaceName, sessionId?: string) => void;
  openSettings: (section?: SlashSettingsSection | null) => void;
  /** Split-pane sessions publish on their own lane, not the App snapshot. */
  subscribeSessionLanes?: SetupLaneSource;
}

/** The newest request seq routed per session. */
const uiOpenSeen = new Map<string, number>();

/** A deleted session's seq goes with it. */
export function releaseUiOpenSeen(sessionId: string): void {
  uiOpenSeen.delete(sessionId);
}

export function useAppUiOpenRequest({
  uiOpenRequest,
  sessionId,
  openConversationCommandSurface,
  openSettings,
  subscribeSessionLanes,
}: UiOpenRequestProps) {
  const route = useRef<(requestSessionId: string, request: Snapshot['uiOpenRequest']) => void>(() => {});
  route.current = (requestSessionId, request) => {
    const seq = Number(request?.seq) || 0;
    if (!request?.command || seq <= (uiOpenSeen.get(requestSessionId) || 0)) return;
    uiOpenSeen.set(requestSessionId, seq);
    // A re-attached renderer replays the retained snapshot; a request older
    // than a few seconds is history, not an instruction.
    if (Number(request.at) > 0 && Date.now() - Number(request.at) > UI_OPEN_REQUEST_TTL_MS) return;
    const command = resolveDesktopSlashCommand(request.command);
    if (!command) {
      if (Object.hasOwn(SETUP_SECTION_TARGETS, request.command)) openSettings(SETUP_SECTION_TARGETS[request.command]);
      return;
    }
    if (command.surface) {
      openConversationCommandSurface(command.surface, requestSessionId);
      return;
    }
    if (command.settingsRow) openSettings(command.settingsRow);
    else if (command.action === 'settings') openSettings(null);
  };
  useEffect(() => route.current(sessionId || '', uiOpenRequest), [sessionId, uiOpenRequest]);
  useEffect(
    () =>
      subscribeSessionLanes?.(({ sessionId: laneSessionId, snapshot }) =>
        route.current(laneSessionId, (snapshot as Pick<Snapshot, 'uiOpenRequest'> | null)?.uiOpenRequest)
      ),
    [subscribeSessionLanes]
  );
}
