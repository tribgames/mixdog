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
        recordLocalSearchBackend('native', performance.now() - startedAt, 'error');
        throw error;
    }
}

export async function rgSupportsPcre2() {
    return true;
}

export async function runRg(argsList, execOptions = {}) {
    const result = await serve(argsList, execOptions, { offset: 0, limit: 0 });
    if (!result.complete) throw unavailable(argsList);
    return result.lines.join('\n');
}

export async function runRgWindowedLines(argsList, execOptions = {}, opts = {}) {
    return serve(argsList, execOptions, opts);
}
