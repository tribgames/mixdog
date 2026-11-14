// Tells an attached core the Electron profile directory when the core's data dir is behind the profile move's
// generation (a core started by the TUI, or before the desktop knew the profile): `migrate/profile/status` reports the
// generation, `migrate/profile/adopt` runs the move. The files it brings (SSH hosts among them) are read by the core
// afterwards, so no restart is needed. A failure is logged and never stops the app.
import type {
  MigrateProfileAdopted,
  MigrateProfileAdoptParams,
  MigrateProfileStatus,
} from '../../../../../packages/protocol/src/index.ts';

/** The generation of the profile move this desktop expects the core's data dir to have reached. */
export const EXPECTED_PROFILE_GENERATION = 2;

export interface ProfileAdoptClient {
  call(method: string, params: unknown): Promise<unknown>;
}

export interface ProfileAdoption {
  adopted: boolean;
  moved: string[];
}

export async function adoptProfileIfBehind(
  client: ProfileAdoptClient,
  userData: string,
  expectedGeneration: number = EXPECTED_PROFILE_GENERATION
): Promise<ProfileAdoption> {
  try {
    const status = (await client.call('migrate/profile/status', {})) as MigrateProfileStatus;
    if (status.generation >= expectedGeneration) return { adopted: false, moved: [] };
    const params: MigrateProfileAdoptParams = { userData };
    const result = (await client.call('migrate/profile/adopt', params)) as MigrateProfileAdopted;
    return { adopted: true, moved: result.moved };
  } catch (error) {
    console.error(`[mixdog] profile adoption failed: ${error instanceof Error ? error.message : String(error)}`);
    return { adopted: false, moved: [] };
  }
}
