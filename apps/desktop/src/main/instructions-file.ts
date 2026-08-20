// Instructions editor (Projects page) file locations, shared by the Electron
// IPC surface and the remote method table so a paired browser edits exactly
// the files the desktop app does.
import { homedir } from 'node:os';
import { resolve } from 'node:path';

/** `~/.mixdog/data` unless MIXDOG_DATA_DIR / MIXDOG_HOME redirect it. */
export function commonDataDir(): string {
  return process.env.MIXDOG_DATA_DIR
    || resolve(process.env.MIXDOG_HOME || resolve(homedir(), '.mixdog'), 'data');
}

/** Common instructions injected as "# Common Instructions". */
export function commonInstructionsFile(): string {
  return resolve(commonDataDir(), 'instructions.md');
}

/** Pre-rename location, read as a fallback so old installs keep their text. */
export function legacyCommonInstructionsFile(): string {
  return resolve(commonDataDir(), 'user-workflow.md');
}

/** `<project>/.mixdog/instructions.md`. */
export function projectInstructionsFile(projectDirectory: string): string {
  return resolve(projectDirectory, '.mixdog', 'instructions.md');
}
