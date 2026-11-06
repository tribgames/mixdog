// Module-loader hooks the flow recorders install before they import Node's modules, so a
// module-level import can be observed or stood in for without changing the code under test:
//
//  - `session-builder.mjs` `prepareAgentSession`: replaced by `globalThis.__flowStub.prepareAgentSession`
//    (the real one builds a whole runtime session);
//  - `human-gate/delegation.mjs` `rebindDelegation`: replaced by `globalThis.__flowStub.rebindDelegation`
//    (a session-record operation that belongs to the session side);
//  - `turn-snapshot.mjs` `beginAgentTurnReview` / `completeAgentTurnReview`: wrapped, so the REAL review
//    collector and review store run and every call is reported to `globalThis.__flowStub.review`.
import { register } from 'node:module';

const hooks = `
export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (result.format !== 'module' || result.source == null) return result;
  let source = String(result.source);
  if (url.endsWith('/agent-runtime/session-builder.mjs')) {
    source = source.replace(/export function prepareAgentSession\\(/, 'function prepareAgentSessionReal(') +
      '\\nexport function prepareAgentSession(...a) { return globalThis.__flowStub.prepareAgentSession(...a); }\\n';
  } else if (url.endsWith('/human-gate/delegation.mjs')) {
    source = source.replace(/export async function rebindDelegation\\(/, 'async function rebindDelegationReal(') +
      '\\nexport function rebindDelegation(...a) { return globalThis.__flowStub.rebindDelegation(...a); }\\n';
  } else if (url.endsWith('/runtime/shared/turn-snapshot.mjs')) {
    source = source
      .replace(/export function beginAgentTurnReview\\(/, 'function beginAgentTurnReviewReal(')
      .replace(/export function completeAgentTurnReview\\(/, 'function completeAgentTurnReviewReal(') +
      '\\nexport function beginAgentTurnReview(...a) { const handle = beginAgentTurnReviewReal(...a); globalThis.__flowStub?.review?.("begin", a, handle); return handle; }' +
      '\\nexport function completeAgentTurnReview(...a) { const done = completeAgentTurnReviewReal(...a); globalThis.__flowStub?.review?.("complete", a, done); return done; }\\n';
  }
  return { ...result, source };
}
`;

export function installFlowHooks() {
  register(`data:text/javascript,${encodeURIComponent(hooks)}`);
}
