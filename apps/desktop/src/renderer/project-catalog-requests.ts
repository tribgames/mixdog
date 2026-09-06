import type { DesktopProjectSummary } from "../shared/contract";

/** Only overlapping refreshes explicitly marked coalescible share a read.
 *  A refresh after a mutation starts a new generation and outranks old reads. */
export function createProjectCatalogRequests(
  load: () => Promise<DesktopProjectSummary[]>,
  accept: (rows: DesktopProjectSummary[], acceptEmpty: boolean) => void,
) {
  type Request = { promise: Promise<DesktopProjectSummary[]>; acceptEmpty: boolean };
  let current: Request | null = null;
  return {
    refresh(options: { acceptEmpty?: boolean; coalesce?: boolean } = {}): Promise<DesktopProjectSummary[]> {
      if (options.coalesce && current) {
        current.acceptEmpty ||= options.acceptEmpty !== false;
        return current.promise;
      }
      const request: Request = {
        acceptEmpty: options.acceptEmpty !== false,
        promise: Promise.resolve([]),
      };
      current = request;
      request.promise = Promise.resolve().then(load).then((rows) => {
        if (current === request) accept(rows, request.acceptEmpty);
        return rows;
      }).finally(() => {
        if (current === request) current = null;
      });
      return request.promise;
    },
    invalidate(): void { current = null; },
  };
}
