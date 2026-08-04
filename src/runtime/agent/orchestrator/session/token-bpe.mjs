// Chunked o200k BPE encode-count, shared by the main thread (context-utils)
// and the token-count worker. BPE merge cost is quadratic in WORD length, not
// text length: a degenerate single-word run ('p'.repeat(250k), base64/minified
// blobs) forms one giant pat_str word and encode() spins for minutes while the
// event loop is blocked. Encoding fixed-size slices caps the worst-case word at
// the chunk size, so cost stays linear. Chunk cuts snap back to the nearest
// whitespace so the next slice starts at a natural ` word` boundary — o200k
// tokenizes that identically to the unsliced text, keeping estimates EXACT for
// prose. Only a whitespace-free degenerate run falls back to a hard cut
// (±1 token per boundary). Hard cuts avoid splitting a surrogate pair so
// sliced emoji/CJK-ext code points still encode cleanly.
const BPE_ENCODE_CHUNK_CHARS = 4_096;
const BPE_CHUNK_BOUNDARY_SCAN = 512;

export function bpeEncodeCount(enc, s) {
    if (s.length <= BPE_ENCODE_CHUNK_CHARS) return enc.encode(s, undefined, []).length;
    let total = 0;
    let i = 0;
    while (i < s.length) {
        let end = Math.min(s.length, i + BPE_ENCODE_CHUNK_CHARS);
        if (end < s.length) {
            // Prefer cutting BEFORE a whitespace run: the next chunk then
            // starts with ` word`, which o200k merges exactly as it would
            // mid-text. Scan a bounded window so degenerate inputs stay O(1).
            let ws = -1;
            const scanFloor = Math.max(i + 1, end - BPE_CHUNK_BOUNDARY_SCAN);
            for (let j = end - 1; j >= scanFloor; j -= 1) {
                const c = s.charCodeAt(j);
                if (c === 0x20 || c === 0x0A || c === 0x0D || c === 0x09) { ws = j; break; }
            }
            if (ws > i) {
                end = ws; // next chunk starts at the whitespace
            } else {
                const last = s.charCodeAt(end - 1);
                if (last >= 0xD800 && last <= 0xDBFF) end += 1;
            }
        }
        total += enc.encode(s.slice(i, end), undefined, []).length;
        i = end;
    }
    return total;
}
