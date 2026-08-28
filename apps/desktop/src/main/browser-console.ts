export type BrowserConsoleLevel = 'debug' | 'info' | 'warning' | 'error';

interface BrowserConsoleEntry {
  level: BrowserConsoleLevel;
  text: string;
}

const LEVEL_RANK: Record<BrowserConsoleLevel, number> = {
  debug: 0,
  info: 1,
  warning: 2,
  error: 3,
};

function normalizeRecordedLevel(value: unknown): BrowserConsoleLevel {
  const level = String(value || '').trim().toLowerCase();
  if (level === 'debug' || level === 'verbose') return 'debug';
  if (level === 'info' || level === 'log') return 'info';
  if (level === 'warning' || level === 'warn') return 'warning';
  if (level === 'error' || level === 'assert') return 'error';
  return 'info';
}

function normalizeFilterLevel(value: unknown): BrowserConsoleLevel | 'all' {
  const level = String(value || 'error').trim().toLowerCase();
  if (level === 'all') return 'all';
  if (level === 'debug' || level === 'info' || level === 'warning' || level === 'error') {
    return level;
  }
  throw new Error('console level must be all, debug, info, warning, or error');
}

export class BrowserConsoleLedger {
  readonly #entries: BrowserConsoleEntry[] = [];
  readonly #sanitize: (value: string) => string;

  constructor(sanitize: (value: string) => string = (value) => value) {
    this.#sanitize = sanitize;
  }

  record(level: unknown, text: unknown): void {
    this.#entries.push({
      level: normalizeRecordedLevel(level),
      text: this.#sanitize(String(text || '')),
    });
    if (this.#entries.length > 200) this.#entries.splice(0, this.#entries.length - 200);
  }

  recordError(text: unknown): void {
    this.record('error', text);
  }

  recentErrors(limit: number): string[] {
    return this.#entries
      .filter((entry) => entry.level === 'error')
      .slice(-Math.max(1, limit))
      .map((entry) => entry.text);
  }

  format(rawLevel: unknown, rawQuery: unknown, rawLimit: unknown): string {
    const level = normalizeFilterLevel(rawLevel);
    const query = String(rawQuery || '').trim().toLowerCase();
    const limit = Math.min(
      200,
      Math.max(1, Number.isFinite(rawLimit) ? Math.trunc(Number(rawLimit)) : 50),
    );
    const minimum = level === 'all' ? -1 : LEVEL_RANK[level];
    const matching = this.#entries.filter((entry) => (
      LEVEL_RANK[entry.level] >= minimum
      && (!query || entry.text.toLowerCase().includes(query))
    ));
    const shown = matching.slice(-limit);
    if (!shown.length) {
      return `No console entries matched level=${level}${query ? ` and query=${JSON.stringify(query)}` : ''}.`;
    }
    return [
      `Recent console entries (${shown.length} shown of ${matching.length}, oldest first):`,
      ...shown.map((entry) => `- [${entry.level}] ${entry.text}`),
    ].join('\n');
  }
}
