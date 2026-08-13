import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';

export const MAX_SELECTED_FILE_GRANTS = 100;

export function selectedFileGrantKey(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function parseSelectedFileGrants(text: string): {
  grants: Map<string, string>;
  migrated: boolean;
} {
  const grants = new Map<string, string>();
  let migrated = false;
  const rows = JSON.parse(text) as unknown;
  if (!Array.isArray(rows)) return { grants, migrated };
  for (const row of rows.slice(-MAX_SELECTED_FILE_GRANTS)) {
    if (!row || typeof row !== 'object') continue;
    const record = row as Record<string, unknown>;
    const file = String(record.file || '');
    if (!isAbsolute(file)) continue;
    const tokenHash = String(record.tokenHash || '');
    if (/^[0-9a-f]{64}$/.test(tokenHash)) {
      grants.set(tokenHash, resolve(file));
      continue;
    }
    const legacyToken = String(record.token || '');
    if (!legacyToken) continue;
    grants.set(selectedFileGrantKey(legacyToken), resolve(file));
    migrated = true;
  }
  return { grants, migrated };
}

export function serializeSelectedFileGrants(grants: Map<string, string>): string {
  return JSON.stringify(
    [...grants.entries()]
      .slice(-MAX_SELECTED_FILE_GRANTS)
      .map(([tokenHash, file]) => ({ tokenHash, file })),
  );
}
