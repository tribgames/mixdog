// Instructions editor (Projects page) file locations, shared by the Electron
// IPC surface and the remote method table so a paired browser edits exactly
// the files the desktop app does.
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { mkdir, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';

const instructionWrites = new Map<string, Promise<unknown>>();

export async function readInstructionsText(file: string, legacyFile = ''): Promise<string> {
  for (const candidate of [file, legacyFile].filter(Boolean)) {
    try {
      return await readFile(candidate, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return '';
}

/** Serialize editor/setup writes to one instruction document, compare the
 * observed text, retain a unique unchanged backup, then atomically replace. */
export function writeInstructionsText(
  file: string,
  content: string,
  expectedContent?: string,
  legacyFile = ''
): Promise<{ backupPath: string }> {
  const path = resolve(file);
  if (basename(path) !== 'instructions.md') return Promise.reject(new Error('Invalid instructions target'));
  const prior = instructionWrites.get(path) || Promise.resolve();
  const operation = prior
    .catch(() => {})
    .then(async () => {
      const current = await readInstructionsText(path, legacyFile);
      if (expectedContent !== undefined && current !== expectedContent) {
        throw new Error('Instructions changed since they were read. Read them again before saving.');
      }
      await mkdir(dirname(path), { recursive: true });
      const workspace = await mkdtemp(join(dirname(path), '.instructions-backup-'));
      const backupPath = join(workspace, 'previous.md');
      await writeFile(backupPath, current, 'utf8');
      const replacement = join(workspace, 'next.md');
      await writeFile(replacement, content, 'utf8');
      if ((await readInstructionsText(path, legacyFile)) !== current) {
        throw new Error(`Instructions changed while saving; nothing replaced. Backup: ${backupPath}`);
      }
      await rename(replacement, path);
      return { backupPath };
    });
  instructionWrites.set(path, operation);
  void operation.then(
    () => {
      if (instructionWrites.get(path) === operation) instructionWrites.delete(path);
    },
    () => {
      if (instructionWrites.get(path) === operation) instructionWrites.delete(path);
    }
  );
  return operation;
}

/** `~/.mixdog/data` unless MIXDOG_DATA_DIR / MIXDOG_HOME redirect it. */
function commonDataDir(): string {
  return process.env.MIXDOG_DATA_DIR || resolve(process.env.MIXDOG_HOME || resolve(homedir(), '.mixdog'), 'data');
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
