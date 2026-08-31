/**
 * Bounded polling shared by the desktop host harnesses. The browser and
 * computer programs all wait for a condition the same way and read the same
 * bridge discovery file, so "eventually" and "discovered" mean one thing across
 * them; only the budget and the retry cost differ per harness.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

export interface BridgeDiscovery {
  port: number;
  token: string;
}

export interface PollingDefaults {
  /** How long a condition may take before the harness calls it a failure. */
  timeoutMs: number;
  /** Gap between attempts. */
  intervalMs: number;
  /** Called once per retry, so a harness can count what waiting cost it. */
  onRetry?: () => void;
}

export function createPolling(defaults: PollingDefaults) {
  async function eventually<T>(
    operation: () => Promise<T>,
    accept: (value: T) => boolean,
    timeoutMs = defaults.timeoutMs,
  ): Promise<T> {
    const startedAt = Date.now();
    let latest = await operation();
    while (!accept(latest) && Date.now() - startedAt < timeoutMs) {
      defaults.onRetry?.();
      await new Promise((resolve) => setTimeout(resolve, defaults.intervalMs));
      latest = await operation();
    }
    assert.ok(accept(latest), `condition was not met within ${timeoutMs}ms`);
    return latest;
  }

  async function readDiscovery(path: string, timeoutMs?: number): Promise<BridgeDiscovery> {
    return await eventually(
      async () => {
        try {
          return JSON.parse(await readFile(path, 'utf8')) as BridgeDiscovery;
        } catch {
          return { port: 0, token: '' };
        }
      },
      (value) => Number.isInteger(value.port) && value.port > 0 && Boolean(value.token),
      timeoutMs,
    );
  }

  return { eventually, readDiscovery };
}
