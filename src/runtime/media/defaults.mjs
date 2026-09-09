/**
 * Remembered lane/model per media kind — "what the user last chose".
 *
 * Written by the Studio pane whenever its selection settles and by every
 * started generation (Studio or the model-facing tool); read by the tool when
 * a call omits lane/model. It lives beside the asset index so the desktop,
 * the daemon, and the TUI all answer the same way, and it survives restarts —
 * the Studio's own localStorage draft never reaches the runtime.
 */
import { mkdirSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { resolvePluginData } from '../shared/plugin-paths.mjs';
import { writeJsonAtomicSync } from '../shared/atomic-file.mjs';
import { MEDIA_KINDS } from './tool-defs.mjs';

const MAX_ID_CHARS = 512;

function defaultsPath() {
  return join(resolvePluginData(), 'media', 'defaults.json');
}

function text(value) {
  return typeof value === 'string' ? value.trim().slice(0, MAX_ID_CHARS) : '';
}

function readAll() {
  try {
    const raw = JSON.parse(readFileSync(defaultsPath(), 'utf8'));
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

/** `{ kind, lane, model }` for the kind, or null when nothing was remembered. */
export function getMediaDefault(kind) {
  const key = text(kind);
  if (!MEDIA_KINDS.includes(key)) return null;
  const row = readAll()[key];
  const lane = text(row?.lane);
  return lane ? { kind: key, lane, model: text(row?.model) } : null;
}

/** Remember the lane (and model) for one kind. `model` may be empty: the lane default then applies. */
export function setMediaDefault({ kind, lane, model } = {}) {
  const key = text(kind);
  if (!MEDIA_KINDS.includes(key)) throw new TypeError(`kind must be one of ${MEDIA_KINDS.join(', ')}`);
  const laneId = text(lane);
  if (!laneId) throw new TypeError('lane is required');
  const entry = { kind: key, lane: laneId, model: text(model) };
  const path = defaultsPath();
  mkdirSync(dirname(path), { recursive: true });
  writeJsonAtomicSync(path, { ...readAll(), [key]: { lane: entry.lane, model: entry.model, updatedAt: Date.now() } });
  return entry;
}
