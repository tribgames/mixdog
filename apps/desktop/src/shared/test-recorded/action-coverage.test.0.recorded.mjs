// Node b6f10295a src/runtime/computer-bridge/core-actions.mjs, recorded from the original test's run; replayed by call.
import { readFileSync } from 'node:fs';
import { replay } from './replay.mjs';

const table = JSON.parse(readFileSync(new URL('./action-coverage.test.0.recorded.json', import.meta.url), 'utf8'));
export const COMPUTER_CORE_ACTION_SCHEMA = replay(table, "COMPUTER_CORE_ACTION_SCHEMA");
export const COMPUTER_DEFAULT_DELIVERY = replay(table, "COMPUTER_DEFAULT_DELIVERY");
export const validateComputerCoreActions = replay(table, "validateComputerCoreActions");
