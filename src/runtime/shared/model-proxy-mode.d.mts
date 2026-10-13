export const MODEL_PROXY_ENV: 'MIXDOG_MODEL_PROXY';
export function modelProxyClientMode(env?: Record<string, string | undefined>): boolean;
export function serverModelCredentialsDisabledError(what?: string): Error & { code: string };
