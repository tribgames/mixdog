export declare const AGENT_MESSAGE_NOTE: string;
export declare function wrapAgentMessage<T extends string | unknown[]>(
  content: T,
  sender: { name: string; agentId: string }
): T;
export declare function stripAgentMessageEnvelope(text: unknown): string;
