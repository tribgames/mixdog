import assert from 'node:assert/strict';

const PUBLIC_FIELDS = ['name', 'usage', 'aliases', 'aliasUsage', 'showAliasUsage', 'params', 'description'];

const publicFields = (command) =>
  Object.fromEntries(
    PUBLIC_FIELDS.filter((field) => Object.hasOwn(command, field)).map((field) => [field, command[field]])
  );

/** Desktop-only commands, excluded from the equality check. connect: the TUI has no remote-PC connection flow. */
export const DESKTOP_ONLY_COMMANDS = ['connect'];

/** Throws when the desktop registry's public fields differ from the TUI's, ignoring `desktopOnly` names. */
export function assertSlashInventoryMatches(desktopCommands, tuiCommands, desktopOnly = DESKTOP_ONLY_COMMANDS) {
  const stale = tuiCommands.filter((command) => desktopOnly.includes(command.name));
  assert.deepEqual(
    stale.map((command) => command.name),
    [],
    'Desktop-only allowlist is stale: the TUI registry now has these commands.'
  );
  assert.deepEqual(
    desktopCommands.filter((command) => !desktopOnly.includes(command.name)).map(publicFields),
    tuiCommands.map(publicFields),
    'Desktop command inventory drifted from the TUI registry.'
  );
}
