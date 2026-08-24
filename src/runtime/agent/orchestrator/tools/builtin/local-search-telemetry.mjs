import { AsyncLocalStorage } from 'node:async_hooks';

const localSearchTelemetry = new AsyncLocalStorage();

export function runWithLocalSearchTelemetry(telemetry, run) {
    return telemetry && typeof telemetry === 'object'
        ? localSearchTelemetry.run(telemetry, run)
        : run();
}

function current() {
    return localSearchTelemetry.getStore();
}

function addNumber(target, key, value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return;
    target[key] = Math.round(((Number(target[key]) || 0) + number) * 10) / 10;
}

export function recordLocalSearchBackend(backend, durationMs, outcome) {
    const target = current();
    if (!target) return;
    const name = String(backend || '').replace(/[^a-z0-9_]/gi, '').toLowerCase();
    const result = String(outcome || 'hit').replace(/[^a-z0-9_]/gi, '').toLowerCase();
    if (!name || !result) return;
    // An outcome already ending in `s` takes `es`, so a miss counts under
    // `native_misses` rather than the unreadable `native_misss`.
    const counter = `${name}_${result.endsWith('s') ? `${result}es` : `${result}s`}`;
    target[counter] = (Number(target[counter]) || 0) + 1;
    addNumber(target, `${name}_ms`, durationMs);
}

export function recordNativeSearchTiming(served) {
    const target = current();
    if (!target || !served || typeof served !== 'object') return;
    const requestClass = ['bulk', 'fuzzy'].includes(served.requestClass)
        ? served.requestClass
        : 'interactive';
    target[`native_${requestClass}_requests`] = (Number(target[`native_${requestClass}_requests`]) || 0) + 1;
    addNumber(target, `native_${requestClass}_queue_ms`, served.queueMs);
    addNumber(target, `native_${requestClass}_handler_ms`, served.handlerMs);
    if (requestClass === 'fuzzy') {
        addNumber(target, 'native_fuzzy_inventory_ms', served.inventoryMs);
        addNumber(target, 'native_fuzzy_rank_ms', served.rankMs);
    }
}

export function recordLocalSearchCacheHit(layer) {
    const target = current();
    if (!target) return;
    const name = String(layer || 'result').replace(/[^a-z0-9_]/gi, '').toLowerCase();
    target.cache_hits = (Number(target.cache_hits) || 0) + 1;
    target.cache_layer = target.cache_layer && target.cache_layer !== name ? 'mixed' : name;
}

export function recordLocalSearchIndex(event, fileCount = null) {
    const target = current();
    if (!target) return;
    const name = String(event || '').replace(/[^a-z0-9_]/gi, '').toLowerCase();
    if (!name) return;
    target[`index_${name}s`] = (Number(target[`index_${name}s`]) || 0) + 1;
    if (Number.isFinite(Number(fileCount))) target.index_files = Math.max(Number(target.index_files) || 0, Number(fileCount));
}
