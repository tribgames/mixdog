/**
 * task-session-route.mjs — the model and reasoning effort a bot asks of a
 * task session (the session tool's `model` / `effort`), checked against the
 * provider catalog the desktop model menu lists (listProviderModels rows:
 * provider, id, display, effortOptions).
 */
import { clean } from '../runtime/agent/orchestrator/runtime-core/session-text.mjs';
import { normalizeEffortInput } from '../runtime/agent/orchestrator/runtime-core/effort.mjs';

// Choices an error names: a short list, never the whole catalog.
const CHOICE_LIMIT = 6;

const lower = (value) => clean(value).toLowerCase();
const rowId = (row) => clean(row.id || row.model);
const sameModel = (row, route) => row.provider === route.provider && lower(rowId(row)) === lower(route.model);
const effortsOf = (row) => (Array.isArray(row?.effortOptions) ? row.effortOptions.map((option) => option.value) : []);
const choiceLabel = (row) => `${row.display || rowId(row)} (${row.provider}/${rowId(row)})`;

function choices(rows) {
  const shown = rows.slice(0, CHOICE_LIMIT).map(choiceLabel).join('; ');
  return rows.length > CHOICE_LIMIT ? `${shown}; … (${rows.length} total)` : shown;
}

/** An effort level word ("max") or null; "auto" is no level. */
function effortWord(word) {
  try {
    return normalizeEffortInput(word);
  } catch {
    return null;
  }
}

/** The catalog rows of the model menu, read through session `sessionId`'s runtime. */
export async function readModelCatalog(service, sessionId) {
  const result = await service.readSession({ sessionId, action: 'listProviderModels', args: [{}] });
  return Array.isArray(result?.value) ? result.value : [];
}

/** The route of a catalog display name (case-insensitive, exact), with a
 *  trailing effort word ("Claude Opus 5.5 max", or auto) read as the effort
 *  only when the whole text names no model. With `explicitEffort` the word
 *  only selects the name: the caller applies its own effort. Throws with the
 *  choices when the text names no model or several. */
export function routeByDisplayName(text, rows, explicitEffort = false) {
  const wanted = lower(text);
  const cut = wanted.lastIndexOf(' ');
  const word = cut > 0 ? wanted.slice(cut + 1) : '';
  const suffix = word === 'auto' || effortWord(word) ? word : null;
  let hits = rows.filter((row) => lower(row.display) === wanted);
  let effort = null;
  if (!hits.length && suffix) {
    const base = wanted.slice(0, cut).trim();
    hits = rows.filter((row) => lower(row.display) === base);
    effort = suffix;
  }
  if (!hits.length) {
    const words = wanted.split(/\s+/).filter(Boolean);
    const near = rows.filter((row) => words.every((word) => lower(row.display).includes(word)));
    throw new Error(
      `session: model "${clean(text)}" is neither a provider/model route, a preset name nor a model display name. ` +
        `Choices: ${choices(near.length ? near : rows)}${suffix ? '. To set the reasoning effort, pass it as the effort field' : ''}`
    );
  }
  const distinct = [...new Map(hits.map((row) => [`${row.provider}/${rowId(row)}`, row])).values()];
  if (distinct.length > 1) {
    throw new Error(`session: model "${clean(text)}" is ambiguous; use provider/model: ${choices(distinct)}`);
  }
  const route = { provider: distinct[0].provider, model: rowId(distinct[0]) };
  return effort && !explicitEffort ? withEffort(route, effort, rows) : route;
}

/** `route` with the effort level `value`, checked against the levels its
 *  model supports ("auto" clears it). A chosen level turns the route's Auto
 *  effort off, as the menu's effort pick does, or Auto would replace it. */
export function withEffort(route, value, rows) {
  const level = checkEffort(value, route, rows);
  const { effort: _previous, ...rest } = route;
  return level ? { ...rest, effort: level, autoEffort: false } : rest;
}

/** The effort level `value` names for `route` ("auto" is null); throws with
 *  the model's levels when it is unknown or unsupported. */
export function checkEffort(value, route, rows) {
  const row = rows.find((candidate) => sameModel(candidate, route));
  const allowed = row ? effortsOf(row) : null;
  const offer = allowed ? `; ${route.provider}/${route.model} supports: auto${allowed.map((level) => `, ${level}`).join('')}` : '';
  let level;
  try {
    level = normalizeEffortInput(value);
  } catch (error) {
    throw new Error(`session: ${error.message}${offer}`);
  }
  if (level && allowed && !allowed.includes(level)) {
    throw new Error(`session: effort "${level}" is not supported${offer}`);
  }
  return level;
}
