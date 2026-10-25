// Approval gate for Chrome password/cookie imports, isolated from Electron so
// it can be unit-tested directly.

/** Thrown when a passwords/cookies import lacks administrator approval. */
export const ADMIN_APPROVAL_REQUIRED = 'Password and cookie import require explicit administrator approval.';

/**
 * A passwords/cookies import runs only with explicit administrator approval
 * (the manual import, whose native importer may use the elevated UAC path);
 * otherwise it is refused. History-only imports never touch the key and are
 * always allowed.
 */
export function requireSensitiveImportApproval(input: {
  hasSensitiveItem: boolean;
  administratorApproved: boolean;
}): void {
  if (input.hasSensitiveItem && !input.administratorApproved) throw new Error(ADMIN_APPROVAL_REQUIRED);
}
