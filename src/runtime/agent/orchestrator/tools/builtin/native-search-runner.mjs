import { performance } from 'node:perf_hooks';
import { tryServeSearch } from './native-search-client.mjs';
import { recordLocalSearchBackend, recordNativeSearchTiming } from './local-search-telemetry.mjs';

function unavailable(argsList) {
    const error = new Error(`native search unavailable or unsupported for args: ${JSON.stringify(argsList)}`);
    error.code = 'NATIVE_SEARCH_UNAVAILABLE';
    return error;
}

async function serve(argsList, execOptions, opts) {
    const startedAt = performance.now();
    try {
        const result = await tryServeSearch(argsList, execOptions, opts);
        if (!result) throw unavailable(argsList);
        recordNativeSearchTiming(result);
        recordLocalSearchBackend('native', performance.now() - startedAt, 'hit');
        return result;
    } catch (error) {
        // Unsupported request shapes are classified separately in telemetry,
        // but still throw: there is no alternate local-search backend.
        const code = String(error?.code || '');
        const outcome = code === 'NATIVE_SEARCH_UNAVAILABLE' || code === 'NATIVE_SEARCH_UNSUPPORTED'
            ? 'miss'
            : 'error';
        recordLocalSearchBackend('native', performance.now() - startedAt, outcome);
        throw error;
    }
}

export async function rgSupportsPcre2() {
    return true;
}

export async function runRg(argsList, execOptions = {}) {
    const result = await serve(argsList, execOptions, { offset: 0, limit: 0 });
    if (!result.complete && !result.partial) throw unavailable(argsList);
    const text = result.lines.join('\n');
    if (!result.partial && result.cacheSafe !== false) return text;
    return Object.assign(new String(text), {
        partial: result.partial === true,
        timeout: result.timeout === true,
        truncated: result.complete !== true,
        cacheSafe: result.cacheSafe !== false,
    });
}

export async function runRgWindowedLines(argsList, execOptions = {}, opts = {}) {
    return serve(argsList, execOptions, opts);
}
