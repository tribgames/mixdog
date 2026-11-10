/**
 * openai-oauth-catalog-store.mjs — where the openai-oauth model catalog is
 * cached, and the catalog's own route successors.
 *
 * Kept free of the provider runtime so config load can read the last fetched
 * catalog synchronously: a saved route on a model the catalog has superseded
 * moves to the model the catalog names for it.
 */
import { makeModelCache } from './model-cache.mjs';
import { accessProgramModelParameters, accessProgramOnly } from '../../../shared/llm/openai-daybreak.mjs';
import { formatScheduleModelRef, parseScheduleModelRef } from '../../../shared/schedule-model-ref.mjs';

export const CODEX_MODEL_CACHE_OPTIONS = Object.freeze({
  fileName: 'openai-oauth-models.json',
  ttlMs: 24 * 60 * 60_000,
  version: 7,
});

export const CODEX_PROVIDER_ID = 'openai-oauth';

let snapshotCache = null;

/** The last saved catalog, stale or not; null when none was ever fetched. */
function savedCatalog() {
  snapshotCache ||= makeModelCache(CODEX_MODEL_CACHE_OPTIONS);
  return snapshotCache.loadSync({ allowStale: true });
}

/**
 * The route a model moves to, read off the catalog alone; null when it stays.
 *  - A standalone access-program variant (its access programs omit the
 *    standard one) moves to the first listed regular model, by catalog
 *    priority, that accepts the same program, with that program's toggle on.
 *  - A model whose `upgrade.retirement_at` has passed moves to `upgrade.model`.
 * Returns { model, modelParameters? }.
 */
export function codexModelSuccessor(models, modelId, now = Date.now()) {
  if (!Array.isArray(models) || !modelId) return null;
  const entry = models.find((model) => model?.id === modelId);
  if (!entry) return null;
  const program = accessProgramOnly(entry);
  if (program) {
    const modelParameters = accessProgramModelParameters(program);
    if (!modelParameters) return null;
    const target = models
      .filter(
        (model) =>
          model?.id &&
          model.id !== modelId &&
          model.hidden !== true &&
          !accessProgramOnly(model) &&
          Array.isArray(model.accessPrograms) &&
          model.accessPrograms.includes(program)
      )
      .sort((a, b) => (a.priority ?? Infinity) - (b.priority ?? Infinity))[0];
    return target ? { model: target.id, modelParameters } : null;
  }
  const upgrade = entry.upgrade;
  const retiresAt = Date.parse(upgrade?.retirementAt || '');
  if (upgrade?.model && Number.isFinite(retiresAt) && retiresAt <= now) return { model: upgrade.model };
  return null;
}

/** A saved openai-oauth route moved to its catalog successor; any other route unchanged. */
export function migrateCodexRoute(route, models = savedCatalog()) {
  if (String(route?.provider || '').trim() !== CODEX_PROVIDER_ID) return route;
  const successor = codexModelSuccessor(models, String(route.model || '').trim());
  if (!successor) return route;
  const current =
    route.modelParameters && typeof route.modelParameters === 'object' && !Array.isArray(route.modelParameters)
      ? route.modelParameters
      : {};
  return {
    ...route,
    model: successor.model,
    ...(successor.modelParameters || Object.hasOwn(route, 'modelParameters')
      ? { modelParameters: { ...current, ...(successor.modelParameters || {}) } }
      : {}),
  };
}

/** A stored schedule/webhook model ref ("provider/model@effort+fast?k=v") moved
 *  to its catalog successor; preset names and current models unchanged. */
export function migrateCodexModelRef(ref, models = savedCatalog()) {
  const route = parseScheduleModelRef(ref);
  if (!route || typeof route !== 'object') return ref;
  const migrated = migrateCodexRoute(route, models);
  return migrated === route ? ref : formatScheduleModelRef(migrated);
}

/** `modelSettings` keys whose model the catalog has superseded (they apply to nothing any more). */
export function supersededCodexSettingsKey(key, models = savedCatalog()) {
  const prefix = `${CODEX_PROVIDER_ID}/`;
  return key.startsWith(prefix) && Boolean(codexModelSuccessor(models, key.slice(prefix.length)));
}

export function loadSavedCodexCatalog() {
  return savedCatalog();
}
