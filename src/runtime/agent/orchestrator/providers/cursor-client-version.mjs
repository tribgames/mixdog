import { createRemoteVersionSource } from './npm-cli-version.mjs';

// Cursor CLI build id for the x-cursor-client-version header. Cursor has no
// documented version endpoint; the official installer script embeds the
// current build (…/lab/<build>/…), parsed best-effort. Any format change or
// failure falls back to the floor.
export const CURSOR_CLIENT_VERSION_FLOOR = 'cli-2026.10.01-e373342';
const BUILD_PATTERN = /downloads\.cursor\.com\/lab\/(\d{4}\.\d{2}\.\d{2}-[0-9a-f]{6,40})\//;
export const CURSOR_INSTALL_URL = 'https://cursor.com/install';

export async function parseCursorInstallBuild(res) {
  const match = (await res.text()).match(BUILD_PATTERN);
  return match ? `cli-${match[1]}` : null;
}

const live = createRemoteVersionSource(CURSOR_INSTALL_URL, parseCursorInstallBuild, { persistKey: 'cursor-cli' });
let envVersion;

function envOverride() {
  if (envVersion === undefined) envVersion = String(process.env.MIXDOG_CURSOR_CLIENT_VERSION || '').trim();
  return envVersion;
}

// Builds are `cli-YYYY.MM.DD-<hash>`: a build replaces another unless it is
// dated earlier or unparseable.
const buildDate = (id) => /^cli-(\d{4}\.\d{2}\.\d{2})-[0-9a-f]+$/.exec(String(id))?.[1] ?? null;
export function cursorBuildNewer(next, current) {
  const nextDate = buildDate(next);
  const currentDate = buildDate(current);
  return Boolean(nextDate && currentDate) && next !== current && nextDate >= currentDate;
}

/** Sync, never blocks; never an older build than the floor. */
export function cursorClientVersion() {
  if (envOverride()) return envOverride();
  const current = live.sync();
  return current && cursorBuildNewer(current, CURSOR_CLIENT_VERSION_FLOOR) ? current : CURSOR_CLIENT_VERSION_FLOOR;
}

/** Await before the first RPC; bounded by the fetch timeout, never rejects. */
export async function warmCursorClientVersion() {
  if (!envOverride()) await live.warm();
}
