// Node b6f10295a2f698afc85332467192de28500bd146 src/runtime/computer-bridge/core-actions.mjs, recorded from apps/desktop/src/main/computer/host/action-coverage.test.mjs of that commit run against an exact export of it (record/record.mjs).
import { readFileSync } from 'node:fs';
import { replay } from './replay.mjs';

const table = JSON.parse(readFileSync(new URL('./action-coverage.test.0.recorded.json', import.meta.url), 'utf8'));
export const COMPUTER_CORE_ACTION_SCHEMA = replay(table, "COMPUTER_CORE_ACTION_SCHEMA");
export const COMPUTER_DEFAULT_DELIVERY = replay(table, "COMPUTER_DEFAULT_DELIVERY");
export const validateComputerCoreActions = replay(table, "validateComputerCoreActions");
