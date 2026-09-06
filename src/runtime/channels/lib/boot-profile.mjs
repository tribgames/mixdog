import { formatUtcTimestamp } from "../../shared/time-format.mjs";
import { BOOT_PROFILE_ENABLED, BOOT_PROFILE_START, createBootProfiler } from "../../shared/boot-profile.mjs";

// Channels-scoped boot-timing instrumentation + shared UTC timestamp helper.
const bootProfile = createBootProfiler("channels");

function utcTimestamp() {
  return formatUtcTimestamp();
}

export { BOOT_PROFILE_ENABLED, BOOT_PROFILE_START, bootProfile, utcTimestamp };
