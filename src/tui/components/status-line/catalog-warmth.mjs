/*
 * components/status-line/catalog-warmth.mjs — whether the pricing catalogs are loaded, and their projections.
 *
 * In Node the TUI process held the LiteLLM and models.dev catalogs in memory once a model list had been asked for
 * (the model pickers and the boot-time prefetch): the footer's model names then came from models.dev too. Here
 * the same moment is `warm()`, called when `listProviderModels` has answered: it reads the catalogs the core keeps
 * in the data dir (`litellm-catalog.json`, `modelsdev-catalog.json`, stored as `{ fetchedAt, data }`), as Node's
 * disk warm did. A catalog whose file has no payload stays cold. Until `warm()` the footer sees none.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { resolvePluginData } from '../../../runtime/shared/plugin-paths.mjs';
import { projectLitellmForHint, projectModelsDevForHint } from './model-display-hint.mjs';

async function readCatalog(file, project) {
  try {
    const raw = JSON.parse(await readFile(file, 'utf8'));
    return raw?.data ? project(raw.data) : null;
  } catch {
    return null;
  }
}

/**
 * `whenReady` is awaited before the files are read (a test's completion signal for the core's background load).
 */
export function createCatalogWarmth({ dataDir = () => resolvePluginData(), whenReady = null } = {}) {
  let catalogs = null;
  let warming = null;
  return {
    /** Loads the catalogs from the data dir (once at a time); resolves when they are resident. Never rejects. */
    warm() {
      warming ??= (async () => {
        if (whenReady) await whenReady();
        const dir = dataDir();
        const [litellm, modelsDev] = await Promise.all([
          readCatalog(join(dir, 'litellm-catalog.json'), projectLitellmForHint),
          readCatalog(join(dir, 'modelsdev-catalog.json'), projectModelsDevForHint),
        ]);
        catalogs = { litellm: litellm || catalogs?.litellm || {}, modelsDev: modelsDev || catalogs?.modelsDev || {} };
      })().finally(() => {
        warming = null;
      });
      return warming;
    },
    /** `{ litellm, modelsDev }` once warmed, else null. */
    get() {
      return catalogs;
    },
  };
}

export const defaultCatalogWarmth = createCatalogWarmth();

/**
 * A model-list call that warms the catalogs where Node's list did (`collectProviderModels`): a quick read returns
 * its rows at once and leaves the load running in the background (the catalogs become resident when it ends, not
 * awaited here); a full read awaits the load, so the catalogs are resident when it resolves.
 */
export function listWithCatalogWarmth(list, warmth = defaultCatalogWarmth) {
  return async (...args) => {
    const models = await list(...args);
    const options = args[0] && typeof args[0] === 'object' ? args[0] : {};
    if (options.quick === true && options.force !== true) {
      void warmth.warm();
      return models;
    }
    await warmth.warm();
    return models;
  };
}
