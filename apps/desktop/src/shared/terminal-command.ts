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
}
