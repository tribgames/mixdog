import { homedir } from 'node:os';
import { join } from 'node:path';

/** Where the host publishes its script, its discovery file, and run history. */
export function mixdogDataDirectory(): string {
  return process.env.MIXDOG_DATA_DIR || join(process.env.MIXDOG_HOME || join(homedir(), '.mixdog'), 'data');
}
