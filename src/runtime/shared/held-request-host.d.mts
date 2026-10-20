export interface HeldRequestPushEvent {
  sessionId: string;
  agentId: string;
  agentName: string;
  requestId: string;
}
export function registerHeldRequestResolver(resolver: (id: string, decision: unknown) => boolean): () => void;
export function resolveHeldRequest(id: string, decision: unknown): boolean;
export function registerHeldRequestNotifier(notifier: (event: HeldRequestPushEvent) => void): () => void;
export function notifyHeldRequest(event: Partial<HeldRequestPushEvent>): void;
export function recordRunOwner(sessionId: string, agentId: string): void;
export function runOwnerOf(sessionId: string): string;
