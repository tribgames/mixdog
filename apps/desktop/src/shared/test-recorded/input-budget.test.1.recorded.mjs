// Node b6f10295a2f698afc85332467192de28500bd146 (tree 332679f9c46ead536c500ab57a7580c0fb28d550) src/runtime/computer-bridge/limits.mjs, recorded from apps/desktop/src/main/computer/backend/input-budget.test.mjs of that commit run against an exact export of it (record/record.mjs).
import { readFileSync } from 'node:fs';
import { replay } from './replay.mjs';

const table = JSON.parse(readFileSync(new URL('./input-budget.test.1.recorded.json', import.meta.url), 'utf8'));
export const MAX_COMPUTER_FOREGROUND_TEXT_CHARS = replay(table, "MAX_COMPUTER_FOREGROUND_TEXT_CHARS");
export const MAX_COMPUTER_IMAGE_CHARS = replay(table, "MAX_COMPUTER_IMAGE_CHARS");
export const MAX_COMPUTER_INTERNAL_REQUEST_BYTES = replay(table, "MAX_COMPUTER_INTERNAL_REQUEST_BYTES");
export const MAX_COMPUTER_REQUEST_BYTES = replay(table, "MAX_COMPUTER_REQUEST_BYTES");
export const MAX_COMPUTER_RESPONSE_BYTES = replay(table, "MAX_COMPUTER_RESPONSE_BYTES");
export const createComputerLineDecoder = replay(table, "createComputerLineDecoder");
export const readComputerBridgeJson = replay(table, "readComputerBridgeJson");
export const validateComputerReply = replay(table, "validateComputerReply");
