/**
 * Canonical reader for registered schedules.
 *
 * `<Mixdog data dir>/schedules/<name>/` is the single source of truth.
 * Each schedule directory contains `config.json` (metadata) and
 * `instructions.md` (prompt body). Both the setup UI (POST /schedules)
 * and the `schedule-add` skill write the same two files; every reader —
 * setup-server (GET /schedules), channels/lib/config.mjs (loadConfig),
 * status/aggregator.mjs — must go through listSchedules() so a single
 * entry shape is presented everywhere.
 *
 * The legacy `mixdog-config.json` `channels.schedules.items` /
 * `channels.nonInteractive` / `channels.interactive` arrays are no longer
 * consulted. Migration: rename any legacy `prompt.md` to `instructions.md`
 * — no in-code fallback.
 */

import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { resolvePluginData } from './plugin-paths.mjs';

function schedulesDir() {
  return join(resolvePluginData(), 'schedules');
}

function readJsonFile(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { return null; }
}

function readTextFile(path) {
  try { return readFileSync(path, 'utf8'); }
  catch { return ''; }
}

/**
 * List every registered schedule.
 *
 * Return shape per entry: `{ name, ...config, prompt }`.
 * - `name` is the directory name (slug).
 * - Spread of `config.json` keys (time/days/type/channel/model/enabled
 *   when written by the setup UI; cron/timezone/mode/role when written
 *   by the schedule-add skill).
 * - `prompt` carries `instructions.md` content (empty string when the
 *   file is missing — caller decides whether that is a hard error).
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
    const cfg = readJsonFile(join(dir, name, 'config.json')) || {};
    const prompt = readTextFile(join(dir, name, 'instructions.md'));
    out.push({ name, ...cfg, prompt });
  }
  return out;
}
