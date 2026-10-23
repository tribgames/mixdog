/** Field of a phone's cut copy of a row holding the whole output's facts. */
export declare const REMOTE_OUTPUT_FACTS_FIELD: 'remoteOutputFacts';
/** The output facts of a tool row's own output (`ToolOutputFacts`, transcript-tool-model.ts). */
export declare function outputFactsOf(item: object, nowMs?: number): Record<string, unknown>;
