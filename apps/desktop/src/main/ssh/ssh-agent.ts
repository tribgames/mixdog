// Is there an ssh-agent holding keys? A passphrase-protected login key only
// works unattended through one, so a failed login shows what is wrong with it.
import type { DesktopSshAgentStatus } from '../../shared/contract-ssh';
import type { RunTool } from './host-key';

const TIMEOUT_MS = 6_000;

export const WINDOWS_AGENT_START_COMMAND =
  'Set-Service ssh-agent -StartupType Manual; Start-Service ssh-agent; ssh-add';
export const WINDOWS_AGENT_STARTED_COMMAND = 'Start-Service ssh-agent; ssh-add';
export const POSIX_AGENT_COMMAND = 'eval "$(ssh-agent -s)" && ssh-add';

const attempt = async (
  run: RunTool,
  command: string,
  args: string[]
): Promise<{ code: number | null; stdout: string } | null> => {
  try {
    const result = await run(command, args, TIMEOUT_MS);
    return { code: result.code, stdout: result.stdout };
  } catch {
    return null;
  }
};

/** `sc query` text → the service state; `sc qc` text → its start type. */
export const parseServiceState = (text: string): 'running' | 'stopped' | 'missing' | 'unknown' => {
  if (/1060|does not exist/i.test(text)) return 'missing';
  const match = /STATE\s*:\s*\d+\s+(\w+)/i.exec(text);
  if (!match) return 'unknown';
  return /RUNNING/i.test(match[1]) ? 'running' : 'stopped';
};
export const serviceIsDisabled = (text: string): boolean => /START_TYPE\s*:\s*\d+\s+DISABLED/i.test(text);

export async function detectSshAgent(
  run: RunTool,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): Promise<DesktopSshAgentStatus> {
  if (platform === 'win32') {
    const service = await attempt(run, 'sc.exe', ['query', 'ssh-agent']);
    const state = service ? parseServiceState(service.stdout) : 'unknown';
    if (state === 'missing') return { state: 'missing' };
    if (state === 'stopped') {
      const config = await attempt(run, 'sc.exe', ['qc', 'ssh-agent']);
      return config && serviceIsDisabled(config.stdout)
        ? { state: 'disabled', command: WINDOWS_AGENT_START_COMMAND }
        : { state: 'stopped', command: WINDOWS_AGENT_STARTED_COMMAND };
    }
  } else if (!env.SSH_AUTH_SOCK) {
    return { state: 'missing', command: POSIX_AGENT_COMMAND };
  }
  const listed = await attempt(run, 'ssh-add', ['-l']);
  if (!listed) return { state: 'unknown' };
  if (listed.code === 0) return { state: 'running' };
  if (listed.code === 1) return { state: 'empty', command: 'ssh-add' };
  return { state: 'missing', command: platform === 'win32' ? WINDOWS_AGENT_STARTED_COMMAND : POSIX_AGENT_COMMAND };
}
