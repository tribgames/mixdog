export type SessionSidebarChange =
  | { favorite: boolean }
  | { archived: boolean }
  | { archived: true; cascade: false }
  | { forgotten: true };
export type SessionSidebarHost = (sessionId: unknown, change: unknown) => unknown;
export type SessionSidebarState = { archived: Record<string, number> };
export function registerSessionSidebarHost(
  host: SessionSidebarHost,
  options?: { state?: (() => SessionSidebarState | Promise<SessionSidebarState>) | null }
): () => void;
export function applySessionSidebarChange(sessionId: string, change: SessionSidebarChange): Promise<void>;
export function readSessionSidebarState(): Promise<SessionSidebarState | null>;
