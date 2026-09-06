/**
 * src/tui/session/boot-profile.mjs - opt-in boot timing trace.
 *
 * Extracted from session-local.mjs. Emits `[mixdog-boot]` stderr lines when
 * MIXDOG_BOOT_PROFILE is truthy; a no-op otherwise.
 */
import { createBootProfiler } from '../../runtime/shared/boot-profile.mjs';

export const bootProfile = createBootProfiler('tui');
