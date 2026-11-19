// The scenario the chat recordings use: a model that answers every chat request with a short streamed text. (The recorders' prompts carry
// no HARNESS-TURN token, so the earlier harness answered them the same way, as its `other` plan.)
export const SCENARIO = {
  respond: () => ({ kind: 'other', deltas: [{ content: 'ok' }], finish: 'stop' }),
};
