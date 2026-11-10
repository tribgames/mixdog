// Resolvers shared by the internal tool handlers: which session and abort
// signal a call runs under, preferring the caller's context over the runtime's.
export function createCallerContextResolvers(rt) {
  return {
    sessionIdFor: (callerCtx) => callerCtx?.sessionId || callerCtx?.callerSessionId || rt.session?.id,
    signalFor: (callerCtx) => callerCtx?.signal || rt.session?.controller?.signal || null,
  };
}
