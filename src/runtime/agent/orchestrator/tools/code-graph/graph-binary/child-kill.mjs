// Kill escalation for a spawned native child: SIGTERM first, then after a
// grace period a forced kill (taskkill /t /f on Windows, SIGKILL elsewhere).
import { spawn } from 'node:child_process';

const KILL_GRACE_MS = 3000;

export function createChildKiller(proc) {
  let killGraceTimer = null;
  const gone = () => proc.exitCode != null || proc.signalCode != null;

  const escalate = () => {
    if (gone()) return;
    const pid = proc.pid;
    if (!pid) return;
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
      } else {
        try {
          proc.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }
  };

  const clearGrace = () => {
    if (killGraceTimer) {
      clearTimeout(killGraceTimer);
      killGraceTimer = null;
    }
  };

  return {
    escalate,
    clearGrace,
    kill() {
      if (gone()) return;
      try {
        proc.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      clearGrace();
      killGraceTimer = setTimeout(() => {
        killGraceTimer = null;
        escalate();
      }, KILL_GRACE_MS);
      killGraceTimer.unref?.();
    },
  };
}
