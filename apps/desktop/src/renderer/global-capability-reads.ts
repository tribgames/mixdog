import type { DesktopApi, DesktopCapabilityReadRequest } from '../shared/contract';

type ReadApi = Partial<Pick<DesktopApi, 'invokeCapability' | 'readCapabilities'>>;
type GlobalReadRequest = Omit<DesktopCapabilityReadRequest, 'sessionId'> & { sessionId?: never };

/** Value-only global getters. Session-scoped reads and commands retain their
 * snapshot-bearing API. Older hosts keep the individual invocation path. */
export async function readGlobalCapabilities(
  api: ReadApi | undefined,
  requests: readonly GlobalReadRequest[]
): Promise<unknown[]> {
  if (!api?.readCapabilities) {
    return Promise.all(requests.map(async (request) => (await api?.invokeCapability?.(request))?.value));
  }
  // requiredDesktopCapabilityReadRequests accepts at most 32 requests.
  const chunks: GlobalReadRequest[][] = [];
  for (let index = 0; index < requests.length; index += 32) {
    chunks.push(requests.slice(index, index + 32));
  }
  const values = await Promise.all(
    chunks.map(async (chunk) => {
      const results = await api.readCapabilities!(chunk);
      return chunk.map((_, index) => {
        const result = results[index];
        if (!result) throw new Error('Capability read did not return a result.');
        if (!result.ok) throw new Error(result.error);
        return result.value;
      });
    })
  );
  return values.flat();
}
