export declare const PROMPT_ORIGIN_CHANNEL: 'channel';
export declare const PROMPT_ORIGIN_AGENT_REPORT: 'agent-report';
export type PromptOrigin = typeof PROMPT_ORIGIN_CHANNEL | typeof PROMPT_ORIGIN_AGENT_REPORT;
export declare function promptOriginOf(value: unknown): PromptOrigin | null;
