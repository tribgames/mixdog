import { useEffect } from 'react';

export const NEW_SCHEDULE_REQUEST_EVENT = 'mixdog:new-schedule-request';

let pendingAgentId: string | null = null;

export function requestNewSchedule(agentId: string): void {
  pendingAgentId = agentId;
  window.dispatchEvent(new Event(NEW_SCHEDULE_REQUEST_EVENT));
}

/** Hand the pending bot to `open` once, while `active`. */
export function useNewScheduleRequest(active: boolean, open: (agentId: string) => void): void {
  // biome-ignore lint/correctness/useExhaustiveDependencies: `open` only reads the latest editor state when it runs
  useEffect(() => {
    if (!active) return undefined;
    const take = () => {
      const agentId = pendingAgentId;
      pendingAgentId = null;
      if (agentId !== null) open(agentId);
    };
    take();
    window.addEventListener(NEW_SCHEDULE_REQUEST_EVENT, take);
    return () => window.removeEventListener(NEW_SCHEDULE_REQUEST_EVENT, take);
  }, [active]);
}
