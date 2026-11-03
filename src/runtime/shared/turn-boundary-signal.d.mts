export const COMMAND_TOOL_NAMES: Set<string>;
export function noteCommandToolSettled(cwd: string): void;
export function onCommandToolSettled(fn: (cwd: string) => void): () => boolean;
export function noteTurnReviewChanged(): void;
export function onTurnReviewChanged(fn: () => void): () => boolean;
