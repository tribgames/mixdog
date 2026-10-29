import net from 'node:net';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { FETCH_BLOCKED_PORTS, FETCH_SAFE_ATTEMPTS } from '../../shared/fetch-safe-listen.mjs';

// whisper.cpp cannot bind port 0 itself. Ask the OS for an available port,
// release the reservation immediately before spawn, then verify the listener's
// PID before treating the child as ready (the handoff is not atomic).
export function selectWhisperPort(host, preferred) {
  const reserve = (port) =>
    new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once('error', reject);
      server.listen({ host, port, exclusive: true }, () => {
        const selected = server.address().port;
        server.close((error) => (error ? reject(error) : resolve(selected)));
      });
    });
  // The server is reached with fetch, which refuses a "bad port" the OS may assign.
  const reserveFetchSafe = async () => {
    for (let attempt = 0; attempt <= FETCH_SAFE_ATTEMPTS; attempt += 1) {
      const port = await reserve(0);
      if (!FETCH_BLOCKED_PORTS.has(port)) return port;
    }
    throw new Error('no fetch-safe loopback port was assigned');
  };
  return reserve(preferred).catch((error) => {
    if (error.code !== 'EADDRINUSE' && error.code !== 'EACCES') throw error;
    return reserveFetchSafe();
  });
}

// Resolves the query's stdout, or null on any failure (spawn error, non-zero
// exit, timeout). Asynchronous so the daemon event loop never parks on the
// ownership query (netstat costs ~54 ms idle and seconds under CPU load).
function runOwnershipQuery(command, args) {
  return new Promise((resolve) => {
    try {
      execFile(
        command,
        args,
        { encoding: 'utf8', windowsHide: true, timeout: 5_000, maxBuffer: 16 * 1024 * 1024 },
        (error, stdout) => resolve(error ? null : String(stdout))
      );
    } catch {
      resolve(null);
    }
  });
}

// Get-NetTCPConnection prints one OwningProcess number per line: no localized words.
export function listenerPidsInclude(stdout, pid) {
  return stdout.split(/\r?\n/).some((line) => line.trim() === String(pid));
}

export async function whisperListenerOwned(host, port, pid) {
  if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(port)) return false;
  try {
    if (process.platform === 'win32') {
      const root = process.env.SystemRoot || 'C:\\Windows';
      // netstat omits listeners when the TCP table is large; the CIM-backed cmdlet does not.
      // The State filter is skipped (it can report an unknown state for live listeners);
      // a listening row is the one with no remote endpoint (RemotePort 0).
      if (!/^[0-9a-fA-F:.]+$/.test(host)) return false;
      const stdout = await runOwnershipQuery(
        path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-NetTCPConnection -LocalAddress '${host}' -LocalPort ${port} -ErrorAction SilentlyContinue | Where-Object RemotePort -eq 0).OwningProcess`,
        ]
      );
      if (stdout === null) return false;
      return listenerPidsInclude(stdout, pid);
    }
    if (process.platform === 'linux') {
      const stdout = await runOwnershipQuery('ss', ['-H', '-ltnp', `sport = :${port}`]);
      if (stdout === null) return false;
      return stdout.split(/\r?\n/).some((line) => {
        const fields = line.trim().split(/\s+/);
        return fields[3] === `${host}:${port}` && new RegExp(`\\bpid=${pid},`).test(line);
      });
    }
    const stdout = await runOwnershipQuery('lsof', [
      '-nP',
      '-a',
      '-p',
      String(pid),
      `-iTCP@${host}:${port}`,
      '-sTCP:LISTEN',
      '-Fp',
    ]);
    return stdout !== null && stdout.split(/\r?\n/).includes(`p${pid}`);
  } catch {
    // No ownership evidence means no readiness and no audio upload.
    return false;
  }
}
