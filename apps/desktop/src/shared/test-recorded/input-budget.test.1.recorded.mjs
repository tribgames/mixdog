// Node b6f10295a src/runtime/computer-bridge/limits.mjs, recorded from the original test's run; replayed by call.
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
