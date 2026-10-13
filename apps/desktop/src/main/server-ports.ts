// The TCP ports listening on the machine this service runs on (the server, for
// a server window): /proc/net/tcp{,6} on Linux, `lsof` on macOS. The owning
// process is named when the kernel lets this user read it; the service's own
// ports are left out.
import { execFile } from 'node:child_process';
import { readdir, readFile, readlink } from 'node:fs/promises';

import type { DesktopServerPort } from '../shared/contract-server-ports';

const LSOF_TIMEOUT_MS = 5_000;
/** At most this many processes are searched for socket owners. */
const MAX_PROCESSES = 4_096;

interface ListeningSocket {
  port: number;
  address: string;
  inode?: string;
  pid?: number;
  process?: string;
}

function ipv4FromProc(hex: string): string {
  // One 32-bit word in host (little-endian) order.
  const bytes = hex.match(/../g) ?? [];
  return bytes
    .reverse()
    .map((byte) => Number.parseInt(byte, 16))
    .join('.');
}

function ipv6FromProc(hex: string): string {
  // Four 32-bit words, each in host (little-endian) order.
  const groups: string[] = [];
  for (let word = 0; word < 4; word += 1) {
    const bytes = (hex.slice(word * 8, word * 8 + 8).match(/../g) ?? []).reverse().join('');
    groups.push(bytes.slice(0, 4), bytes.slice(4, 8));
  }
  const mapped = groups.slice(0, 5).every((group) => group === '0000') && groups[5]?.toLowerCase() === 'ffff';
  if (mapped) return ipv4FromProc(hex.slice(24, 32));
  const compact = groups.map((group) => Number.parseInt(group, 16).toString(16)).join(':');
  if (compact === '0:0:0:0:0:0:0:0') return '::';
  if (compact === '0:0:0:0:0:0:0:1') return '::1';
  return compact;
}

/** The LISTEN rows of /proc/net/tcp (`family` 4) or /proc/net/tcp6 (6). */
export function parseProcNetTcp(text: string, family: 4 | 6): ListeningSocket[] {
  const sockets: ListeningSocket[] = [];
  for (const line of text.split('\n').slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 10 || fields[3] !== '0A') continue;
    const [addressHex, portHex] = fields[1].split(':');
    const port = Number.parseInt(portHex ?? '', 16);
    if (!addressHex || !Number.isInteger(port) || port <= 0) continue;
    sockets.push({
      port,
      address: family === 4 ? ipv4FromProc(addressHex) : ipv6FromProc(addressHex),
      inode: fields[9],
    });
  }
  return sockets;
}

/** `lsof -nP -iTCP -sTCP:LISTEN -F pcn` output. */
export function parseLsofListen(text: string): ListeningSocket[] {
  const sockets: ListeningSocket[] = [];
  let pid: number | undefined;
  let command: string | undefined;
  for (const line of text.split('\n')) {
    const tag = line[0];
    const value = line.slice(1).trim();
    if (tag === 'p') {
      pid = Number(value) || undefined;
      command = undefined;
    } else if (tag === 'c') {
      command = value;
    } else if (tag === 'n') {
      const match = value.match(/^(.*):(\d+)$/);
      if (!match) continue;
      const host = match[1].replace(/^\[(.*)\]$/, '$1');
      sockets.push({
        port: Number(match[2]),
        address: host === '*' ? '0.0.0.0' : host,
        ...(pid ? { pid } : {}),
        ...(command ? { process: command } : {}),
      });
    }
  }
  return sockets;
}

/** One entry per port, its addresses merged, sorted by port. */
export function mergeListeningSockets(sockets: ListeningSocket[], ownPid: number): DesktopServerPort[] {
  const byPort = new Map<number, DesktopServerPort>();
  for (const socket of sockets) {
    if (socket.pid === ownPid) continue;
    const entry = byPort.get(socket.port) ?? { port: socket.port, addresses: [] };
    if (!entry.addresses.includes(socket.address)) entry.addresses.push(socket.address);
    if (!entry.process && socket.process) entry.process = socket.process;
    if (!entry.pid && socket.pid) entry.pid = socket.pid;
    byPort.set(socket.port, entry);
  }
  return [...byPort.values()].sort((a, b) => a.port - b.port);
}

/** Socket inode → owning pid and name, for the processes this user may read. */
async function socketOwners(inodes: Set<string>): Promise<Map<string, { pid: number; process?: string }>> {
  const owners = new Map<string, { pid: number; process?: string }>();
  if (!inodes.size) return owners;
  const pids = (await readdir('/proc').catch(() => [] as string[])).filter((name) => /^\d+$/.test(name));
  for (const pid of pids.slice(0, MAX_PROCESSES)) {
    const fds = await readdir(`/proc/${pid}/fd`).catch(() => null);
    if (!fds) continue;
    let name: string | undefined;
    for (const fd of fds) {
      const link = await readlink(`/proc/${pid}/fd/${fd}`).catch(() => '');
      const inode = link.match(/^socket:\[(\d+)\]$/)?.[1];
      if (!inode || !inodes.has(inode) || owners.has(inode)) continue;
      name ??= (await readFile(`/proc/${pid}/comm`, 'utf8').catch(() => '')).trim() || undefined;
      owners.set(inode, { pid: Number(pid), ...(name ? { process: name } : {}) });
    }
    if (owners.size === inodes.size) break;
  }
  return owners;
}

async function linuxListening(): Promise<ListeningSocket[]> {
  const sockets: ListeningSocket[] = [];
  for (const [file, family] of [
    ['/proc/net/tcp', 4],
    ['/proc/net/tcp6', 6],
  ] as const) {
    const text = await readFile(file, 'utf8').catch(() => null);
    if (text !== null) sockets.push(...parseProcNetTcp(text, family));
  }
  const owners = await socketOwners(
    new Set(sockets.map((socket) => socket.inode).filter((inode): inode is string => Boolean(inode && inode !== '0')))
  );
  return sockets.map((socket) => ({ ...socket, ...(socket.inode ? owners.get(socket.inode) : {}) }));
}

function macListening(): Promise<ListeningSocket[]> {
  return new Promise((resolve, reject) => {
    execFile(
      'lsof',
      ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pcn'],
      { timeout: LSOF_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
      (error, stdout) => {
        // lsof exits 1 when nothing listens.
        if (error && !stdout) {
          if ((error as { code?: unknown }).code === 1) resolve([]);
          else reject(new Error(`lsof failed: ${error.message}`));
          return;
        }
        resolve(parseLsofListen(String(stdout)));
      }
    );
  });
}

export async function listListeningPorts(platform: NodeJS.Platform = process.platform): Promise<DesktopServerPort[]> {
  if (platform === 'linux') return mergeListeningSockets(await linuxListening(), process.pid);
  if (platform === 'darwin') return mergeListeningSockets(await macListening(), process.pid);
  throw new Error(`Listing listening ports is not supported on ${platform}.`);
}
