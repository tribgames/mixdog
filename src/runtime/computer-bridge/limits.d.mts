export const MAX_COMPUTER_REQUEST_BYTES: number;
export const MAX_COMPUTER_INTERNAL_REQUEST_BYTES: number;
export const MAX_COMPUTER_RESPONSE_BYTES: number;
export const MAX_COMPUTER_TEXT_CHARS: number;
export const MAX_COMPUTER_IMAGE_CHARS: number;
export function validateComputerReply(value: unknown): void;
export function readComputerBridgeJson(response: Response, maximum?: number): Promise<unknown>;
export function createComputerLineDecoder(onLine: (line: string) => void, maximum?: number): (chunk: string) => void;
