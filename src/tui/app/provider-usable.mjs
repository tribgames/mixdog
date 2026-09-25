/**
 * provider-usable.mjs — the one "is this provider usable" rule every TUI
 * surface applies to a provider setup row.
 *
 * The rule follows the row contract of providerSetup() in
 * src/standalone/provider-admin.mjs: OAuth rows always carry `usable` (from the
 * credential's own describe()) and local rows carry `usable` = detected &&
 * enabled, so the field is authoritative when present. API-key rows carry no
 * `usable`; for them only a credential (`authenticated`: env, keychain or
 * runtime key) counts — `enabled` without one is the "No Key" state. A row that
 * requires sign-in again is never usable.
 */
export function providerRowUsable(row) {
  if (!row || row.reauthRequired === true) return false;
  return row.usable != null ? row.usable === true : row.authenticated === true;
}
