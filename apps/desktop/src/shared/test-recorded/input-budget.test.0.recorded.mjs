// Node b6f10295a src/runtime/computer-bridge/action-schema.mjs, recorded from the original test's run; replayed by call.
import { readFileSync } from 'node:fs';
import { replay } from './replay.mjs';

const table = JSON.parse(readFileSync(new URL('./input-budget.test.0.recorded.json', import.meta.url), 'utf8'));
export const COMPUTER_ACTION_CONTRACTS = replay(table, "COMPUTER_ACTION_CONTRACTS");
export const COMPUTER_INPUT_SCHEMA = replay(table, "COMPUTER_INPUT_SCHEMA");
export const COMPUTER_OBSERVATION_ACTIONS = replay(table, "COMPUTER_OBSERVATION_ACTIONS");
export const normalizeComputerToolArgs = replay(table, "normalizeComputerToolArgs");
export const toComputerHostCommand = replay(table, "toComputerHostCommand");
export const validateComputerToolArgs = replay(table, "validateComputerToolArgs");
