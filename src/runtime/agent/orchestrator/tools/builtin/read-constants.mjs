import { SMART_READ_MAX_BYTES } from './read-formatting.mjs';

// Read tool caps.
//
// READ_MAX_SIZE_BYTES (10 MB) — fast-path file-size threshold mirroring
// Reference FAST_PATH_MAX_SIZE (readFileInRange.ts:44). Files at or below
// this size use readFile + in-memory split by default, which CC measured at
// ~2x faster than createReadStream + readline for typical source. Explicit
// offset/limit windows on files above READ_STREAM_RANGE_MIN_BYTES take the
// streaming path too, so a targeted read avoids materialising a whole
// medium/large document just to return a few lines. Default no-range reads
// switch to the streaming smart-summary path once the file is large enough
// to trigger output elision anyway.
//
// READ_WHOLE_FILE_MAX_BYTES (256 KiB) — soft threshold: default whole-file
// reads larger than this prefer stream smart-elide + READ_MAX_OUTPUT_BYTES
// truncation (proceed with cap) rather than refusing. Hard in-memory cap
// for loading a full file remains READ_MAX_SIZE_BYTES (10 MiB).
//
// READ_MAX_OUTPUT_BYTES (30 KB) — output-truncation cap. Lead-facing default tightened from 50k. Mirrors CC's
// MAX_OUTPUT_SIZE intent (utils/file.ts:48) and the throw-vs-truncate
// trade-off Anthropic chose in #21841 (throw is more token-efficient).
// NOTE: CC's parallel output budget is maxTokens = 25,000 tokens
// (limits.ts:18), enforced post-read via a tokenizer throw. mixdog
// caps on BYTES at read time instead (no tokenizer in the hot path);
// 30 KB ≈ well under a 25k-token budget, so the byte cap is left as-is
// rather than converted to a token count that can't be expressed
// cleanly without a tokenizer.
export const READ_MAX_SIZE_BYTES = 10 * 1024 * 1024;
export const READ_WHOLE_FILE_MAX_BYTES = 256 * 1024;
export const READ_MAX_OUTPUT_BYTES = 30_000;
export const READ_STREAM_RANGE_MIN_BYTES = 128 * 1024;
export const READ_SMART_STREAM_MIN_BYTES = SMART_READ_MAX_BYTES;
export const READ_BATCH_RANGE_COALESCE_GAP_LINES = 256;
export const READ_LARGE_TAIL_MAX_BYTES = 4 * 1024 * 1024;
export const READ_STREAM_TIMEOUT_MS = 20_000;
// Hard cap on bytes scanned in a single ranged streaming read (~512 MiB).
export const READ_MAX_SCAN_BYTES = 512 * 1024 * 1024;
// Per-line accumulation cap while streaming (before renderReadLine truncates).
export const READ_MAX_LINE_COLLECT_BYTES = READ_MAX_OUTPUT_BYTES;
