// Scans the instance's logs and crash captures, which carry what the core forwards from the host, SSH, browser and
// computer paths, for secrets: the run's own session token, private keys, bearer tokens, provider keys, user:password
// URLs and `password=`-style assignments with a real value. Findings name file, line and kind; the secret is never printed.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';

export const name = 'host-forwarding logs hold no secrets';

const MAX_BYTES = 32 * 1024 * 1024;
const TEXT_EXT = new Set(['.log', '.txt', '.err', '.out', '.jsonl', '.json', '']);
/** Files that hold credentials by design and are not logs. */
const NOT_LOGS = new Set(['daemon.json', 'mixdog-config.json', 'source.json']);
const REDACTED = /^(?:\[?<?\*{3,}>?\]?|\[?redacted\]?|<redacted>|null|undefined|true|false|none|\$\{?\w+\}?|%\w+%|x{4,})$/i;
const PATTERNS = [
  ['private key', /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/],
  ['sk- key', /\bsk-[A-Za-z0-9_-]{20,}/],
  ['github token', /\bgh[pousr]_[A-Za-z0-9]{30,}/],
  ['aws key id', /\bAKIA[0-9A-Z]{16}\b/],
  ['bearer token', /\bBearer\s+([A-Za-z0-9._~+/=-]{20,})/i],
  ['url credentials', /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:([^\s/@]{3,})@/i],
  ['secret assignment', /\b(?:pass(?:word|wd|phrase)?|secret|token|api[_-]?key|private[_-]?key)["']?\s*[:=]\s*["']?([^\s"',;&}\]]{8,})/i],
];

/** Kinds of secret found in one line; `literals` are exact secrets of this run. */
export function scanLine(line, literals = []) {
  const found = [];
  for (const literal of literals) if (line.includes(literal)) found.push('session token of this run');
  for (const [kind, re] of PATTERNS) {
    const m = re.exec(line);
    if (!m) continue;
    const value = m[1];
    if (value !== undefined && REDACTED.test(value)) continue;
    found.push(kind);
  }
  return found;
}

function* files(dir, depth = 0) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (depth < 4) yield* files(p, depth + 1);
    } else if (!NOT_LOGS.has(e.name) && TEXT_EXT.has(extname(e.name).toLowerCase())) yield p;
  }
}

/** The folders that hold the instance's logs and crash captures. */
export function logRoots(env) {
  const { info } = env;
  const roots = [join(info.dataDir, 'daemon-crash'), join(info.dataDir, 'logs'), join(info.profile, 'logs'), join(info.profile, 'runtime')];
  if (info.logPath) roots.push(dirname(info.logPath));
  return [...new Set(roots)].filter((r) => existsSync(r));
}

export function scanFiles(paths, literals) {
  const findings = [];
  let scannedFiles = 0;
  let scannedLines = 0;
  for (const file of paths) {
    let text;
    try {
      if (statSync(file).size > MAX_BYTES) {
        findings.push({ file, line: 0, kind: `larger than ${MAX_BYTES} bytes, not scanned` });
        continue;
      }
      text = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    scannedFiles += 1;
    text.split(/\r?\n/).forEach((line, i) => {
      scannedLines += 1;
      for (const kind of scanLine(line, literals)) findings.push({ file, line: i + 1, kind });
    });
  }
  return { findings, scannedFiles, scannedLines };
}

export async function run({ env }) {
  const tokens = Object.values(env.doc?.endpoints ?? {}).map((e) => e?.token).filter((t) => typeof t === 'string' && t.length >= 8);
  const roots = logRoots(env);
  const all = new Set();
  for (const root of roots) for (const f of files(root)) all.add(f);
  const { findings, scannedFiles, scannedLines } = scanFiles([...all], tokens);
  const lower = [...all].map((f) => f.toLowerCase());
  const coverage = ['ssh', 'browser', 'computer'].map((path) => `${path}:${lower.some((f) => f.includes(path)) ? 'own log' : 'core log only'}`).join(' ');
  const capture = existsSync(join(env.info.dataDir, 'daemon-crash')) ? 'present' : 'absent';
  const summary = `${scannedFiles} files, ${scannedLines} lines under ${roots.length} folders; crash capture dir ${capture}; paths ${coverage}`;
  if (findings.length) {
    const shown = findings.slice(0, 20).map((f) => `${f.file}:${f.line} ${f.kind}`).join('; ');
    throw new Error(`${findings.length} secret findings (${shown}); ${summary}`);
  }
  return `no secrets found; ${summary}`;
}
