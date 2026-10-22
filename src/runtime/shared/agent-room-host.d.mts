export interface AgentRoomTurnDetail {
  status: string;
  result?: { content: string };
  error?: string;
}
export interface AgentRoomHost {
  member(
    roomSessionId: string,
    request: { to?: unknown; prompt?: unknown }
  ): Promise<{ agentId: string; name: string; sessionId: string; text: string }>;
  ask(
    roomSessionId: string,
    request: {
      agentId: string;
      prompt: unknown;
      from: { sessionId: string; agentId?: string };
      id?: string;
      hop?: number;
      onSettled?: (detail: AgentRoomTurnDetail) => void;
      follow?: (submissionId: string) => unknown;
    }
  ): Promise<boolean>;
  relay(
    memberSessionId: string,
    prompt: string,
    options?: { id?: string; hop?: number; follow?: (submissionId: string) => unknown }
  ): Promise<{ settled: Promise<string> }>;
}
export function registerAgentRoomHost(host: AgentRoomHost): () => void;
export function agentRoomHost(): AgentRoomHost;
