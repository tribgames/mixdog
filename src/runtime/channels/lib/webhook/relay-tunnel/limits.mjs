// Size and timing limits of the webhook relay leg.
export const MAX_TUNNEL_BODY_BYTES = 1024 * 1024;
export const MAX_HOOK_FRAME_BYTES = 2 * 1024 * 1024;
export const MAX_HOOK_HEADER_BYTES = 32 * 1024;
export const HEARTBEAT_MS = 25_000;
export const LOCAL_TIMEOUT_MS = 25_000;
