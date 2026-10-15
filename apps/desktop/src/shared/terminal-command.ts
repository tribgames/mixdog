/** Terminal input that runs `command`, entering each line in turn. */
export function terminalCommandInput(command: string): string {
  return `${command.replace(/\r\n?/g, '\n').replace(/\n+$/, '').replace(/\n/g, '\r')}\r`;
}

/** Main → renderer: the agent's `terminal` tool runs a command in a session's
 *  side terminal. Without `command` the session's terminal dock is only
 *  revealed (the command was already written to an existing tab); with it the
 *  renderer opens a tab and enters the command. */
export interface DesktopTerminalRunRequest {
  sessionId: string;
  command?: string;
  /** Correlates a `command` with the tool call waiting on it: the renderer
   *  claims it (`claimTerminalRun`) just before entering the command and enters
   *  nothing when the claim is refused. */
  requestId?: string;
  /** The tool call gave up on this earlier `requestId`; drop its queued input. */
  cancelRequestId?: string;
}
