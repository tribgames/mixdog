/**
 * How an Anthropic stream names its provider in errors (`display`) and stderr
 * lines (`tag`). The OAuth provider is the default; the API-key provider
 * passes its own.
 */
export const OAUTH_STREAM_LABELS = Object.freeze({ display: 'Anthropic OAuth', tag: 'anthropic-oauth' });
