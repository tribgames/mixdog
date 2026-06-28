/**
 * Soft-warn marker stripper.
 *
 * The tool-loop guard subsystem (repeated/fanned-out tool-use detection and its
 * soft-warn sidecars) was removed once every warn path had been disabled. This
 * module now retains a single utility:
 *   • stripSoftWarns — strips legacy soft-warn marker blocks from outbound
 *     bodies so older transcripts that still carry them stay clean.
 */

// Strip soft-warn marker blocks (header ⚠ <label> through next blank line / EOF)
// from outbound bodies. Never call on tool-result bodies fed back to the model.
// New compact format: each warn is a single line starting with `⚠ <Label>(` and ending at newline.
// Legacy multi-line markers retained for older transcripts: `⚠ ... soft-warn ...` block until blank line.
const SOFT_WARN_RE = /⚠\s+(?:Tool-loop|Repeated-tool|Repeated-input|Tool-budget|Same-file\s+multi-chunk|Same-file\s+reads|Same-slice\s+reads|Edit-miss|Mixed-tool|Bash\s+file-lookup|Iteration|0-match)\([^\n]*\n?|⚠\s+(?:(?:Tool-loop|Repeated-tool|Repeated-input|Tool-budget|Same-file\s+multi-chunk|Same-file\s+reads|Same-slice\s+reads|Edit-miss|Mixed-tool|Bash\s+file-lookup|Iteration)\s+soft-warn|0-match\s+(?:family-switch\s+advisory|ESCALATED))[^]*?(?:\n\s*\n|$)/g;
export function stripSoftWarns(text) {
    if (typeof text !== 'string' || text.length === 0) return text;
    return text.replace(SOFT_WARN_RE, '');
}
