// Preloaded (NODE_OPTIONS=--import) into the recorded Node processes of a scenario that holds the statusline-usage warm-up
// (MIXDOG_RECORDER_HOLD_DIR set). The warm-up's preparation (`refreshIdleStatuslineUsage`, statusline-usage-warmup.mjs:29)
// enables the route's OAuth provider through `ensureProvidersReady`; the registry applies that config and moves the catalog
// revision (registry.mjs:312), and the next model-list read drops the caches the earlier reads filled (model-meta.mjs:18,
// web-search-catalog.mjs:112). Its 800 ms timer races the scenario's reads, so here the preparation waits until the recorder
// writes <dir>/release: a directory watch and one deadline, whose failure names what it waited for. Without the variable
// nothing is hooked.
import { existsSync, watch } from 'node:fs';
import { register } from 'node:module';
import { join } from 'node:path';

const dir = process.env.MIXDOG_RECORDER_HOLD_DIR;
if (dir) {
  register('./hold-hooks.mjs', import.meta.url);
  globalThis.__mixdogRecorderHold = () =>
    new Promise((resolve, reject) => {
      const released = () => existsSync(join(dir, 'release'));
      const finish = (error) => {
        clearTimeout(timer);
        watcher.close();
        if (error) reject(error);
        else resolve();
      };
      const watcher = watch(dir, () => released() && finish());
      const timer = setTimeout(() => finish(new Error('the recorder did not release the statusline-usage warm-up within 170 s')), 170_000);
      if (released()) finish();
    });
}
