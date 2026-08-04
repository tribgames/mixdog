/** Typed events produced by the termio pipeline (see termio-keypress.js). */
export type ParsedInput = {
    kind: 'key' | 'mouse' | 'response';
    sequence?: string;
    isPasted?: boolean;
    [key: string]: unknown;
};
export type InputParser = {
    push: (chunk: string) => ParsedInput[];
    flush: () => ParsedInput[];
    hasPendingEscape: () => boolean;
    flushPendingEscape: () => ParsedInput[] | undefined;
    reset: () => void;
};
export declare const createInputParser: () => InputParser;
