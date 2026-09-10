import type { ComputerCommand } from '../shared/types';
import { CHROME_SETUP_SESSION_ID } from '../session/chrome-setup';
import { OBSERVE_ONLY_ALLOWED_ACTIONS } from './action-sets';

/** Recheck the live setting at admission and immediately before each input transport. */
export function assertObservationInputAllowed(command: ComputerCommand, observeOnly: boolean): void {
  if (observeOnly && !OBSERVE_ONLY_ALLOWED_ACTIONS.has(command.action)
    && command.session_id !== CHROME_SETUP_SESSION_ID) {
    throw new Error(`observation_only: Computer Use is observing only, so '${command.action}' input is blocked. Turn off "Observation only" in Settings to allow input.`);
  }
}
