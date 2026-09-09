import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// whisper.cpp cannot bind port 0 itself. Ask the OS for an available port,
// release the reservation immediately before spawn, then verify the listener's
// PID before treating the child as ready (the handoff is not atomic).
export function selectWhisperPort(host, preferred) {
  const reserve = (port) => new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen({ host, port, exclusive: true }, () => {
      const selected = server.address().port;
      server.close((error) => error ? reject(error) : resolve(selected));
    });
  });
  return reserve(preferred).catch((error) => {
    if (error.code !== 'EADDRINUSE' && error.code !== 'EACCES') throw error;
    return reserve(0);
  });
}

export function whisperListenerOwned(host, port, pid) {
  if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(port)) return false;
  const options = { encoding: 'utf8', windowsHide: true, timeout: 5_000 };
  try {
    if (process.platform === 'win32') {
      const root = process.env.SystemRoot || 'C:\\Windows';
      const result = spawnSync(path.join(root, 'System32', 'netstat.exe'), ['-ano', '-p', 'tcp'], options);
      if (result.status !== 0) return false;
      return result.stdout.split(/\r?\n/).some((line) => {
        const fields = line.trim().split(/\s+/);
        return fields[0] === 'TCP' && fields[1] === `${host}:${port}`
          && fields[3] === 'LISTENING' && fields[4] === String(pid);
      });
    }
    if (process.platform === 'linux') {
      const result = spawnSync('ss', ['-H', '-ltnp', `sport = :${port}`], options);
      if (result.status !== 0) return false;
      return result.stdout.split(/\r?\n/).some((line) => {
        const fields = line.trim().split(/\s+/);
        return fields[3] === `${host}:${port}`
          && new RegExp(`\\bpid=${pid},`).test(line);
      });
    }
    const result = spawnSync('lsof', ['-nP', '-a', '-p', String(pid), `-iTCP@${host}:${port}`, '-sTCP:LISTEN', '-Fp'], options);
    return result.status === 0 && result.stdout.split(/\r?\n/).includes(`p${pid}`);
  } catch {
    // No ownership evidence means no readiness and no audio upload.
    return false;
  }
}
