/** Native HTTP timeouts: the abort signal below bounds the caller's wait, these
 *  bound the native socket itself so an abandoned request does not linger. */
export const NATIVE_HTTP_TIMEOUT_MS = 10_000;

interface NativeRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  data?: unknown;
  responseType: 'text';
  connectTimeout: number;
  readTimeout: number;
}
interface NativeResponse {
  status: number;
  data?: unknown;
}

/** A fetch over a native HTTP request that honors `init.signal` (the native
 *  call itself cannot be cancelled, so the wait is raced against the abort). */
export function createNativeFetch(request: (options: NativeRequest) => Promise<NativeResponse>): typeof fetch {
  return async (input, init) => {
    const signal = init?.signal ?? undefined;
    signal?.throwIfAborted();
    const native = request({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: (init?.headers as Record<string, string> | undefined) ?? {},
      data: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      responseType: 'text',
      connectTimeout: NATIVE_HTTP_TIMEOUT_MS,
      readTimeout: NATIVE_HTTP_TIMEOUT_MS,
    });
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal?.reason);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
    let response: NativeResponse;
    try {
      response = await (signal ? Promise.race([native, aborted]) : native);
    } finally {
      if (onAbort) signal?.removeEventListener('abort', onAbort);
      native.catch(() => {});
    }
    const text = typeof response.data === 'string' ? response.data : JSON.stringify(response.data ?? '');
    return new Response(text, { status: response.status });
  };
}
