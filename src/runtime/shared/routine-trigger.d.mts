export interface RoutineTrigger {
  kind: 'schedule' | 'webhook';
  name: string;
  event?: string;
}

export declare const ROUTINE_QUIET: 'ROUTINE_QUIET';
export declare function isRoutineQuietReply(text: unknown): boolean;
export declare function routineTriggerHeader(input: {
  kind: string;
  name: string;
  project?: string;
  now?: Date | number;
}): string;
export declare function stripRoutineTriggerHeader(text: unknown): string;
export declare function normalizeRoutineTrigger(value: unknown): RoutineTrigger | null;
export declare function routineTriggerField(value: unknown): { routineTrigger?: RoutineTrigger };
