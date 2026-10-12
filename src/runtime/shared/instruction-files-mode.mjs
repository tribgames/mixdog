// The `instructionFiles` agent-config setting: which user instruction files
// (AGENTS.md / CLAUDE.md) new sessions load into the system prompt.
export const INSTRUCTION_FILES_MODES = Object.freeze(['all', 'agents', 'claude', 'off']);
export const DEFAULT_INSTRUCTION_FILES_MODE = 'off';

/** Absent or invalid values fall back to the default. */
export function normalizeInstructionFilesMode(value) {
  return INSTRUCTION_FILES_MODES.includes(value) ? value : DEFAULT_INSTRUCTION_FILES_MODE;
}
