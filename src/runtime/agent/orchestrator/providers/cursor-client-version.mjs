import { createRemoteVersionSource } from './npm-cli-version.mjs';

// Cursor CLI build id for the x-cursor-client-version header. Cursor has no
// documented version endpoint; the official installer script embeds the
// current build (…/lab/<build>/…), parsed best-effort. Any format change or
// failure falls back to the floor.
export const CURSOR_CLIENT_VERSION_FLOOR = 'cli-2026.10.01-e373342';
const BUILD_PATTERN = /downloads\.cursor\.com\/lab\/(\d{4}\.\d{2}\.\d{2}-[0-9a-f]{6,40})\//;

const live = createRemoteVersionSource(
  'https://cursor.com/install',
  async (res) => {
    const match = (await res.text()).match(BUILD_PATTERN);
    return match ? `cli-${match[1]}` : null;
  },
  { persistKey: 'cursor-cli' }
);
let envVersion;

function envOverride() {
  if (envVersion === undefined) envVersion = String(process.env.MIXDOG_CURSOR_CLIENT_VERSION || '').trim();
  return envVersion;
}

/** Sync, never blocks. */
export function cursorClientVersion() {
  return envOverride() || live.sync() || CURSOR_CLIENT_VERSION_FLOOR;
}

/** Await before the first RPC; bounded by the fetch timeout, never rejects. */
export async function warmCursorClientVersion() {
  if (!envOverride()) await live.warm();
}
