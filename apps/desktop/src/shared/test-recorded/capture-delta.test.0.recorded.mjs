// Node b6f10295a src/runtime/computer-bridge/result-canonical.mjs, recorded from the original test's run; replayed by call.
import { readFileSync } from 'node:fs';
import { replay } from './replay.mjs';

const table = JSON.parse(readFileSync(new URL('./capture-delta.test.0.recorded.json', import.meta.url), 'utf8'));
export const canonicalComputerResultIsError = replay(table, "canonicalComputerResultIsError");
export const canonicalComputerResultText = replay(table, "canonicalComputerResultText");
export const computerImageDimensions = replay(table, "computerImageDimensions");
