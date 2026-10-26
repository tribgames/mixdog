// Mixy's heartbeat interval setting (`heartbeatIntervalMinutes` in the config):
// one of a few fixed choices, shared by the runtime, the desktop's IPC check
// and the Settings picker. "Off" is the separate `heartbeat` switch.
export const HEARTBEAT_INTERVAL_CHOICES = Object.freeze([30, 60, 120, 240]);
export const DEFAULT_HEARTBEAT_INTERVAL_MINUTES = 60;

/** `value` when it is one of the choices, else the default (a stored value
 *  that is no longer, or never was, a choice reads as the default). */
export function normalizeHeartbeatIntervalMinutes(value) {
  return HEARTBEAT_INTERVAL_CHOICES.includes(value) ? value : DEFAULT_HEARTBEAT_INTERVAL_MINUTES;
}

/** `value` when it is one of the choices; throws otherwise (a write). */
export function requireHeartbeatIntervalMinutes(value) {
  if (!HEARTBEAT_INTERVAL_CHOICES.includes(value)) {
    throw new Error(`heartbeat interval must be one of ${HEARTBEAT_INTERVAL_CHOICES.join(', ')} minutes`);
  }
  return value;
}
