/**
 * DEV-ONLY — must NEVER ship in the published package.
 * Excluded from the npm tarball via package.json "files" negation
 * ("!src/tui/dev"), and only ever imported when MIXDOG_TUI_DEV is set.
 *
 * Rebuilds the React/Ink TUI bundle (src/tui/dist/index.mjs) from JSX source
 * just before launch, so local source edits reflect on the next `mixdog` run
 * without a manual `npm run build:tui`.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function rebuildTuiFromSource() {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const script = join(root, 'scripts', 'build-tui.mjs');
  const res = spawnSync(process.execPath, [script], {
    stdio: process.env.MIXDOG_TUI_DEV_VERBOSE ? 'inherit' : 'ignore',
    windowsHide: true,
  });
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(`build-tui exited with ${res.status}`);
}
