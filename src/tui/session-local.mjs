// Compatibility entry for existing consumers. The daemon owns the implementation
// and its module-level prewarm state; re-exporting keeps one instance.
export * from '../standalone/local-session-runtime.mjs';
