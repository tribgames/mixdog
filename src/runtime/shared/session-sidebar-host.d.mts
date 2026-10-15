export type SessionSidebarChange = { favorite: boolean } | { archived: boolean };
export type SessionSidebarHost = (sessionId: unknown, change: unknown) => unknown;
export function registerSessionSidebarHost(host: SessionSidebarHost): () => void;
export function applySessionSidebarChange(sessionId: string, change: SessionSidebarChange): Promise<void>;
