const CONVENTIONAL_HEADER = /^[a-z][a-z0-9-]*(?:\([^\r\n()]+\))?!?: \S.*$/;

/** Conventional Commits validates the header grammar, not a fixed type enum.
 *  Custom types remain valid alongside common types such as feat/fix/revert. */
export function isConventionalCommitMessage(message: string): boolean {
  const [header = ''] = String(message || '').trim().split(/\r?\n/, 1);
  return CONVENTIONAL_HEADER.test(header);
}
