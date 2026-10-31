// The one usability check for an editable instruction file (an orchestration
// mode, an output style): the editor's state, the prompt builders and the save
// path all decide with it, so the settings page never shows text the prompt
// does not use. Required by the CJS rules builder and imported by the ESM runtime.
'use strict';

/** Largest instruction file read or written (the agent editor's 256 KB text limit). */
const INSTRUCTION_FILE_MAX_BYTES = 256 * 1024;

const utf8 = new TextDecoder('utf-8', { fatal: true });

/** Nothing but NUL bytes and whitespace — what a crash leaves of a file. */
function holdsNoData(buffer) {
  for (const byte of buffer) {
    if (byte !== 0 && byte !== 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) return false;
  }
  return true;
}

/**
 * The file's bytes → `{ text }` (decoded, BOM dropped, otherwise as written)
 * or `{ problem }`: 'too-large', 'empty' (no data), 'not-text' (NUL bytes or
 * invalid UTF-8).
 */
function decodeInstructionFile(buffer) {
  if (buffer.length > INSTRUCTION_FILE_MAX_BYTES) return { problem: 'too-large' };
  if (holdsNoData(buffer)) return { problem: 'empty' };
  if (buffer.includes(0)) return { problem: 'not-text' };
  try {
    return { text: utf8.decode(buffer).replace(/^\uFEFF/, '') };
  } catch {
    return { problem: 'not-text' };
  }
}

module.exports = { INSTRUCTION_FILE_MAX_BYTES, decodeInstructionFile };
