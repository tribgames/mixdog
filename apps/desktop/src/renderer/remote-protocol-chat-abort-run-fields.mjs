// The values of Node's abort recording that are a run's own: two recordings of the same cases (remote-protocol-chat-abort.recorded.json and
// remote-protocol-chat-abort.rerecorded.json, the same recorder run twice) differ in exactly these fields and in no other
// (remote-protocol-chat-abort-run-fields.test.mjs). The live test compares them by what is not random about them and everything else as it is.
/** Wall-clock times (ms): present as numbers, in Node's order (see the live test's `timeFacts`). `elapsedMs` is a duration; `attemptId` is minted per run. */
export const RUN_TIMES = ['at', 'createdAt', 'updatedAt', 'activityAt', 'startedAt', 'completedAt'];
export const RUN_OTHERS = ['elapsedMs', 'attemptId'];
/** Ids minted per run: a row `id` that is not a submission id (the submission ids are fixed by the case), `messageId`, and the id a turn end names its answer by. */
export const RUN_IDS = ['id', 'messageId', 'finalAssistantId'];
export const VARYING_FIELDS = [...RUN_TIMES, ...RUN_OTHERS, ...RUN_IDS].sort();
