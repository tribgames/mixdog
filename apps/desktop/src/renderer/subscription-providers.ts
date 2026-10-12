// The subscriptions the usage flyout lists, in its order, under the names the
// flyout and the subscription usage view both show.
export const SUBSCRIPTIONS = [
  { key: 'codex', label: 'Codex', provider: 'openai-oauth' },
  { key: 'claude', label: 'Claude', provider: 'anthropic-oauth' },
  { key: 'grok', label: 'Grok', provider: 'grok-oauth' },
  { key: 'muse-code', label: 'Muse Code', provider: 'muse-code-oauth' },
  { key: 'mimo', label: 'MiMo', provider: 'mimo-oauth' },
  { key: 'cursor', label: 'Cursor', provider: 'cursor-oauth' },
  { key: 'antigravity', label: 'Antigravity', provider: 'antigravity-oauth' },
  { key: 'opencode-go', label: 'OpenCode Go', provider: 'opencode-go' },
] as const;

export type Subscription = (typeof SUBSCRIPTIONS)[number];

/** The flyout's name for a subscription provider; null for any other. */
export function subscriptionLabel(provider: string): string | null {
  return SUBSCRIPTIONS.find((row) => row.provider === provider)?.label ?? null;
}

/** The flyout's position of a subscription provider; any other sorts last. */
export function subscriptionRank(provider: string): number {
  const index = SUBSCRIPTIONS.findIndex((row) => row.provider === provider);
  return index < 0 ? SUBSCRIPTIONS.length : index;
}
