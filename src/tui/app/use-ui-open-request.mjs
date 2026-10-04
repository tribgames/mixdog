// Setup tool `open`: the session store publishes { command, seq } when the
// model asks for a settings surface; each new seq runs that slash command
// exactly as if the user had typed it (own claim, own notices).
import { useEffect, useRef } from 'react';

/** Setup `open` targets that are settings sections without a slash command
 *  (SETUP_SECTION_OPEN_TARGETS in the runtime setup tool). */
export const SETUP_SECTION_TARGETS = Object.freeze({
  developer: ({ openDeveloperPicker }) => openDeveloperPicker(),
  voice: ({ openSettingsPicker }) => openSettingsPicker(),
  connection: ({ pushNotice }) =>
    pushNotice('Web-app pairing lives in the Desktop app: Settings → Connection.', 'info'),
});

export function useUiOpenRequest({ uiOpenRequest, runSlashCommand, sections }) {
  const seenRef = useRef(0);
  useEffect(() => {
    const request = uiOpenRequest;
    const seq = Number(request?.seq) || 0;
    if (!request?.command || seq <= seenRef.current) return;
    seenRef.current = seq;
    // A re-attached TUI replays the retained snapshot; a request older than a
    // few seconds is history, not an instruction.
    if (Number(request.at) > 0 && Date.now() - Number(request.at) > 15_000) return;
    if (Object.hasOwn(SETUP_SECTION_TARGETS, request.command)) SETUP_SECTION_TARGETS[request.command](sections);
    else runSlashCommand(request.command);
  }, [uiOpenRequest, runSlashCommand, sections]);
}
