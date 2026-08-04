// Shared literal constants for the apply_patch modules. Extracted from
// patch.mjs verbatim so parsing/dispatch behavior is unchanged.

export const DEV_NULL = /^\/dev\/null$/;
export const V4A_EOF_MARKER = '*** End of File';
export const V4A_MOVE_TO_PREFIX = '*** Move to:';

export const UNIFIED_HUNK_HEADER_RE = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/;
export const UNIFIED_HUNK_HEADER_CAPTURE_RE = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@(.*)$/;
