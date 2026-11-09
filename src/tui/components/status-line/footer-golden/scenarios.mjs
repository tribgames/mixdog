// The footer scenarios recorded from Node (b6f10295a `src/ui/statusline.mjs` `renderStatusline`) into
// node-footer.golden.json by record.mjs, and replayed against the TUI-side renderer by footer-render.test.mjs.
// `files` are written under the data dir; `args` are renderStatusline's arguments.
export const T0 = 1_800_000_000_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const STATS = { currentContextTokens: 52_000, currentContextSource: 'last_api_request', turns: 3 };
const base = (provider, model, extra = {}) => ({
  provider,
  model,
  effort: 'high',
  fast: false,
  ultra: false,
  cwd: '/work',
  stats: STATS,
  sessionId: 'sess-footer',
  contextWindow: 200_000,
  displayContextWindow: 0,
  rawContextWindow: 200_000,
  agentWorkers: [],
  agentJobs: [],
  activeTools: null,
  clientHostPid: 4242,
  ...extra,
});
const cache = (routes) => ({ 'gateway-oauth-usage-cache.json': JSON.stringify({ version: 1, updatedAt: T0, routes }) });
const codexWindows = [
  { label: '5H', usedPct: 42, resetAt: T0 + 2 * HOUR, source: 'openai-codex' },
  { label: '7D', usedPct: 71.4, resetAt: T0 + 3 * DAY, source: 'openai-codex' },
];
const events = (rows) => ({
  'gateway-usage.local.jsonl': rows.map((row) => JSON.stringify(row)).join('\n') + '\n',
});

export const SCENARIOS = [
  {
    name: 'openai-oauth wide: 5H and 7D with resets',
    cols: 120,
    args: base('openai-oauth', 'gpt-5.5'),
    files: cache({ 'openai-oauth': { cachedAt: T0, quotaWindows: codexWindows } }),
  },
  {
    name: 'openai-oauth at 100 columns shows two windows',
    cols: 100,
    args: base('openai-oauth', 'gpt-5.5'),
    files: cache({ 'openai-oauth\u0001gpt-5.5': { cachedAt: T0, quotaWindows: [...codexWindows, { label: '30D', usedPct: 9, resetAt: T0 + 9 * DAY, source: 'openai-codex' }] } }),
  },
  {
    name: 'openai-oauth at 60 columns shows one window, no alignment',
    cols: 60,
    args: base('openai-oauth', 'gpt-5.5'),
    files: cache({ 'openai-oauth': { cachedAt: T0, quotaWindows: codexWindows } }),
  },
  {
    name: 'anthropic-oauth with credits balance and a non-default account',
    cols: 120,
    args: base('anthropic-oauth', 'claude-opus-4-7', { effort: 'xhigh', fast: true }),
    files: {
      'provider-accounts.json': JSON.stringify({
        version: 1,
        providers: { 'anthropic-oauth': { accounts: [{ id: 'default', label: 'Account 1' }, { id: '3f2b8c1e-5a4d-4e6f-9b7a-1c2d3e4f5a6b', label: 'Work' }], selectedId: '3f2b8c1e-5a4d-4e6f-9b7a-1c2d3e4f5a6b' } },
      }),
      ...cache({
        'anthropic-oauth': { cachedAt: T0 - 5 * 60_000, quotaWindows: [{ label: '5H', usedPct: 99, resetAt: T0 + HOUR }] },
        'anthropic-oauth\u00023f2b8c1e-5a4d-4e6f-9b7a-1c2d3e4f5a6b': {
          cachedAt: T0,
          quotaWindows: [
            { label: '5H', usedPct: 83, resetAt: T0 + 40 * 60_000, source: 'anthropic-oauth' },
            { label: '7D', usedPct: 12, resetAt: T0 + 5 * DAY, source: 'anthropic-oauth' },
          ],
          balance: { remainingUsd: 12.5, source: 'anthropic-extra-usage' },
        },
      }),
    },
  },
  {
    name: 'grok-oauth with dollar and credit windows',
    cols: 120,
    args: base('grok-oauth', 'grok-4', { effort: '' }),
    files: cache({
      'grok-oauth': {
        cachedAt: T0,
        quotaWindows: [
          { label: 'CREDIT', remainingUsd: 3.2, source: 'grok-billing', resetAt: T0 + 6 * HOUR },
          { label: 'M', usedUsd: 4.5, limitUsd: 20, source: 'grok-billing' },
          { label: 'PRO', remainingCredits: 1250, limitCredits: 5000, usedPct: 80, source: 'grok-billing' },
        ],
      },
    }),
  },
  {
    name: 'a snapshot older than the process is not shown for an OAuth route',
    cols: 120,
    args: base('openai-oauth', 'gpt-5.5'),
    files: cache({ 'openai-oauth': { cachedAt: T0 - DAY, quotaWindows: codexWindows } }),
  },
  {
    name: 'plain API route: session spend and a configured budget balance',
    cols: 120,
    args: base('deepseek', 'deepseek-chat', { effort: '' }),
    files: {
      'mixdog-config.json': JSON.stringify({ gateway: { balance: { budgetUsd: 50, period: '30d' } } }),
      ...events([
        { ts: T0 + 1000, provider: 'deepseek', model: 'deepseek-chat', costUsd: 0.0123 },
        { ts: T0 + 2000, provider: 'deepseek', model: 'deepseek-chat', costUsd: 0.4 },
        { ts: T0 + 3000, provider: 'other', model: 'x', costUsd: 9 },
      ]),
    },
  },
  {
    name: 'plain API route with no events and no balance shows no usage segment',
    cols: 120,
    args: base('deepseek', 'deepseek-chat', { effort: '' }),
    files: {},
  },
  {
    name: 'configured local budget window with spend',
    cols: 120,
    args: base('mixdog-local', 'qwen3-coder', { effort: '' }),
    files: {
      'mixdog-config.json': JSON.stringify({ gateway: { quotaWindows: { daily: { limitUsd: 10, source: 'local-budget' } } } }),
      ...events([{ ts: T0 - HOUR, provider: 'mixdog-local', model: 'qwen3-coder', costUsd: 2.5 }]),
    },
  },
  {
    name: 'gateway module disabled hides the primary status',
    cols: 120,
    args: base('openai-oauth', 'gpt-5.5'),
    files: {
      'mixdog-config.json': JSON.stringify({ modules: { gateway: { enabled: false } } }),
      ...cache({ 'openai-oauth': { cachedAt: T0, quotaWindows: codexWindows } }),
    },
  },
  {
    name: 'second line: agents, web search and a running memory cycle',
    cols: 120,
    args: base('openai-oauth', 'gpt-5.5', {
      agentWorkers: [
        { tag: 'explore-1', agent: 'explore-agent', status: 'running', startedAt: T0 - 65_000 },
        { tag: 'cycle1', agent: 'cycle1-agent', status: 'running', startedAt: T0 - 5_000 },
        { tag: 'old', agent: 'worker', status: 'done', startedAt: T0 - 500_000 },
      ],
      agentJobs: [{ tag: 'job-1', taskId: 't1', status: 'running', startedAt: T0 - 12_000 }],
      activeTools: { web_search: { count: 2, startedAt: T0 - 30_000 } },
    }),
    files: {
      ...cache({ 'openai-oauth': { cachedAt: T0, quotaWindows: codexWindows } }),
      'memory-cycle-state.json': JSON.stringify({
        updatedAt: T0 - 1000,
        running: { cycle: 'cycle1', started_at: T0 - 42_000 },
        backlog: { unchunked: 900 },
      }),
    },
  },
  {
    name: 'a stale memory cycle marker is ignored',
    cols: 120,
    args: base('openai-oauth', 'gpt-5.5'),
    files: {
      ...cache({ 'openai-oauth': { cachedAt: T0, quotaWindows: codexWindows } }),
      'memory-cycle-state.json': JSON.stringify({
        updatedAt: T0 - 11 * 60_000,
        running: { cycle: 'cycle1', started_at: T0 - 42_000 },
      }),
    },
  },
  {
    name: 'model names: catalog display names across providers',
    cols: 120,
    args: base('gemini', 'gemini-2.5-pro', { effort: 'medium' }),
    files: {},
  },
  {
    name: 'model names: dated Claude id on an API route',
    cols: 120,
    args: base('anthropic', 'claude-sonnet-4-5-20250929', { effort: '' }),
    files: {},
  },
  {
    name: 'model names: GLM and a long custom id at 60 columns',
    cols: 60,
    args: base('zai', 'glm-4.6-very-long-custom-fine-tune-identifier-v2', { effort: 'low', fast: true, ultra: true }),
    files: {},
  },
];