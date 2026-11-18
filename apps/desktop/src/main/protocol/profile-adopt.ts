// Tells an attached core the Electron profile directory when files still need moving or the canonical Markdown
// preference is still absent. A failure is logged and can be retried on the next attach without a restart.
import type {
  MigrateProfileAdopted,
  MigrateProfileAdoptParams,
  MigrateProfileStatus,
} from '../../../../../packages/protocol/src/index.ts';

/** Generation 3 of the native profile supplement moves User/settings.json. */
export const EXPECTED_PROFILE_GENERATION = 3;
const MARKDOWN_DEFAULT_VIEW = 'desktop.editor.markdownDefaultView';

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
    if (status.generation >= expectedGeneration) {
      // The file-move journal can be current even if the later config write failed.
      const { config } = (await client.call('config/read', { keys: [MARKDOWN_DEFAULT_VIEW] })) as {
        config: Record<string, unknown>;
      };
      if (Object.hasOwn(config, MARKDOWN_DEFAULT_VIEW)) return { adopted: false, moved: [] };
    }
    const params: MigrateProfileAdoptParams = { userData };
    const result = (await client.call('migrate/profile/adopt', params)) as MigrateProfileAdopted;
    return { adopted: true, moved: result.moved };
  } catch (error) {
    console.error(`[mixdog] profile adoption failed: ${error instanceof Error ? error.message : String(error)}`);
    return { adopted: false, moved: [] };
  }
}
