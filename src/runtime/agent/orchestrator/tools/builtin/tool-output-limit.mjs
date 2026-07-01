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
