/**
 * Canonical reader for registered schedules.
 *
 * `<Mixdog data dir>/schedules/<name>/` is the single source of truth.
 * Each schedule directory contains a single `SCHEDULE.md` — YAML-ish
 * frontmatter (metadata: time/timezone/days/channel/model/enabled) plus a
 * markdown body (the prompt). Both the setup UI (POST /schedules) and the
 * `schedule-add` skill write the same one file; every reader —
 * setup-server (GET /schedules), channels/lib/config.mjs (loadConfig),
 * status/aggregator.mjs — must go through listSchedules() so a single
 * entry shape is presented everywhere.
 *
 * The legacy `mixdog-config.json` `channels.schedules.items` /
 * `channels.nonInteractive` / `channels.interactive` arrays are no longer
 * consulted. Clean cut: the old `config.json` + `instructions.md` pair is
 * no longer read — no in-code fallback.
 */

import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { resolvePluginData } from './plugin-paths.mjs';
import { readMarkdownDocument } from './markdown-frontmatter.mjs';

function schedulesDir() {
  return join(resolvePluginData(), 'schedules');
}

function readTextFile(path) {
  try { return readFileSync(path, 'utf8'); }
  catch { return ''; }
}

/**
 * List every registered schedule.
 *
 * Return shape per entry: `{ name, ...frontmatter, prompt }`.
 * - `name` is the directory name (slug).
 * - Spread of `SCHEDULE.md` frontmatter keys (time/timezone/days/channel/
 *   model/enabled). All frontmatter values arrive as strings; `enabled` is
 *   cast to a boolean here so downstream `s.enabled !== false` filters work.
 * - `prompt` carries the `SCHEDULE.md` body (empty string when the file is
 *   missing — caller decides whether that is a hard error).
 *
 * Returns an empty array when the directory does not exist (fresh
 * install with no schedules registered yet).
 */
export function listSchedules() {
  const dir = schedulesDir();
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    // ENOENT (fresh install, no schedules/ yet) / EACCES -> empty list.
    // Replaces the previous existsSync check, which was racy: the dir
    // could disappear between existsSync and readdirSync.
    return out;
  }
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const name = ent.name;
    const { frontmatter, body } = readMarkdownDocument(readTextFile(join(dir, name, 'SCHEDULE.md')));
    const cfg = { ...frontmatter };
    // Frontmatter is all-strings; cast enabled so `s.enabled !== false`
    // filters (config.mjs, scheduler.mjs) treat `enabled: false` correctly.
    if (Object.prototype.hasOwnProperty.call(cfg, 'enabled')) {
      cfg.enabled = cfg.enabled !== 'false' && cfg.enabled !== false;
    }
    out.push({ name, ...cfg, prompt: body });
  }
  return out;
}
