/** Optional Chrome trace export. Preserve event structure/timing, redact
 * sensitive values, and refuse growth instead of removing user artifacts. */
import { randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, lstatSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { redactBrowserText } from './redaction';

const MAX_TRACE_BYTES = 16 * 1024 * 1024;
const MAX_TRACE_STORE_BYTES = 256 * 1024 * 1024;

function sanitize(value: unknown, redact: (text: string) => string, depth = 0): unknown {
  if (depth > 20) return '[depth limit]';
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.slice(0, 10_000).map((entry) => sanitize(entry, redact, depth + 1));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    redact(key),
    /cookie|authorization|password|passwd|secret|token|api.?key/i.test(key)
      ? '[REDACTED]' : sanitize(entry, redact, depth + 1),
  ]));
}

export class BrowserTraceExport {
  private events: string[] = [];
  private bytes = 0;
  private dropped = 0;
  constructor(private readonly redact: (text: string) => string = redactBrowserText, private readonly maxBytes = MAX_TRACE_BYTES) {}

  add(events: unknown): void {
    if (!Array.isArray(events)) return;
    for (const event of events) {
      if (this.bytes >= this.maxBytes) { this.dropped++; continue; }
      const raw = JSON.stringify(event);
      if (!raw || Buffer.byteLength(raw) > this.maxBytes - this.bytes) {
        this.dropped++;
        continue;
      }
      const encoded = JSON.stringify(sanitize(event, this.redact));
      const size = Buffer.byteLength(encoded) + 1;
      if (this.bytes + size > this.maxBytes) { this.dropped++; continue; }
      this.events.push(encoded);
      this.bytes += size;
    }
  }

  serialize(): string {
    return `{"traceEvents":[${this.events.join(',')}],"metadata":{"redacted":true,"droppedEvents":${this.dropped}}}`;
  }

  save(directory: string): { path: string; bytes: number } {
    mkdirSync(directory, { recursive: true });
    let used = 0;
    const names = readdirSync(directory);
    if (names.length >= 1_000) throw new Error('browser trace store file limit reached');
    for (const name of names) {
      const info = lstatSync(join(directory, name));
      if (info.isFile()) used += info.size;
    }
    const data = this.serialize();
    const bytes = Buffer.byteLength(data);
    if (used + bytes > MAX_TRACE_STORE_BYTES) throw new Error('browser trace store is full; preserve or remove old traces before recording again');
    const path = join(directory, `trace-${randomUUID()}.json`);
    writeFileSync(path, data, { flag: 'wx', mode: 0o600 });
    return { path, bytes };
  }
}
