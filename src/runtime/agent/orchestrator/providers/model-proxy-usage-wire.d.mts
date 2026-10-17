export interface ModelProxyQuotaWindow {
  label: string;
  usedPct: number;
  resetAt?: number;
  usedUsd?: number;
  limitUsd?: number;
  remainingUsd?: number;
  usedCredits?: number;
  limitCredits?: number;
  remainingCredits?: number;
}

export interface ModelProxyUsageSnapshot {
  provider: string;
  accountId: string;
  source: 'desktop-oauth';
  cachedAt: number;
  quotaWindows: ModelProxyQuotaWindow[];
}

export type ModelProxyUsageReply =
  | {
      status: 'ready';
      accounts: string[];
      account: string;
      snapshot: ModelProxyUsageSnapshot;
    }
  | {
      status: 'unsupported' | 'unavailable';
      accounts: string[];
      account?: string;
    };

export function isModelProxyUsageAccount(value: unknown): value is string;
export function sanitizeModelProxyUsageReply(provider: unknown, value: unknown): ModelProxyUsageReply;
