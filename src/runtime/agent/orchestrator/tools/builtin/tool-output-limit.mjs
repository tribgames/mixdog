// Single source of truth for the model-facing tool-output byte budget.
// read / shell / list-tree all truncate their output to this cap so the
// context cost of any one tool call is bounded and consistent. Override with
// MIXDOG_TOOL_OUTPUT_MAX_BYTES. Line-based sub-caps (e.g. bash max lines) stay
// per-tool; this governs only the byte budget.
function _envInt(name, fallback) {
    const v = parseInt(process.env[name], 10);
    return Number.isFinite(v) && v > 0 ? v : fallback;
}
export const TOOL_OUTPUT_MAX_BYTES = _envInt('MIXDOG_TOOL_OUTPUT_MAX_BYTES', 50 * 1024);
export const LOCATOR_OUTPUT_MAX_BYTES = _envInt('MIXDOG_LOCATOR_OUTPUT_MAX_BYTES', 20 * 1024);
export const CODE_GRAPH_OUTPUT_MAX_BYTES = _envInt('MIXDOG_CODE_GRAPH_OUTPUT_MAX_BYTES', 30 * 1024);

function _prefixByBytes(value, maxBytes) {
    const text = String(value || '');
    let lo = 0;
    let hi = text.length;
    while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (Buffer.byteLength(text.slice(0, mid), 'utf8') <= maxBytes) lo = mid;
        else hi = mid - 1;
    }
    return text.slice(0, lo);
}

// Preserve complete leading rows and replace the omitted tail with a
// tool-specific continuation. Unlike the generic middle truncator this keeps
// locator/graph output structurally usable and byte-accurate.
export function capLineOrientedToolOutput(result, maxBytes, footerForPrefix) {
    if (typeof result !== 'string' || !(Number(maxBytes) > 0)) return result;
    const cap = Math.trunc(Number(maxBytes));
    if (Buffer.byteLength(result, 'utf8') <= cap) return result;
    const lines = result.split(/\r?\n/);
    let lo = 0;
    let hi = lines.length;
    let best = '';
    while (lo <= hi) {
        const mid = Math.floor((lo + hi) / 2);
        const kept = lines.slice(0, mid);
        const footer = String(footerForPrefix?.(kept, lines) || '... [output budget reached; remainder omitted]');
        const candidate = `${kept.join('\n')}${kept.length ? '\n' : ''}${footer}`;
        if (Buffer.byteLength(candidate, 'utf8') <= cap) {
            best = candidate;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    if (best) return best;
    return _prefixByBytes(
        String(footerForPrefix?.([], lines) || '... [output budget reached; remainder omitted]'),
        cap,
    );
}
