import { VISUALIZE_INLINE_KINDS } from '../shared/visualize';
import { t } from './i18n';
import { asRecord, formatElapsed, oneLine } from './text-format';
import { boundedTextOf } from './transcript-tool-core';
import { visualizeInlineKindLabel } from './visualize-card-model';

// Getters: each read resolves in the ACTIVE language, not the boot language.
export const TOOL_DETAIL_LABELS = {
  get arguments() {
    return t('Arguments');
  },
  get before() {
    return t('Before');
  },
  get after() {
    return t('After');
  },
  get answer() {
    return t('Answer');
  },
  get questions() {
    return t('Questions');
  },
  get todos() {
    return t('Todos');
  },
  get plan() {
    return t('Plan');
  },
  get running() {
    return t('Running');
  },
  get completed() {
    return t('Completed');
  },
  get failed() {
    return t('Failed');
  },
  get queued() {
    return t('Queued');
  },
  get cancelled() {
    return t('Cancelled');
  },
  get timeout() {
    return t('Timed out');
  },
  get pending() {
    return t('Pending');
  },
  get background() {
    return t('Background');
  },
  get targets() {
    return t('Targets');
  },
  get prompt() {
    return t('Prompt');
  },
};

const TOOL_ACTIVITY_CODE_LANGUAGES = new Map([
  ['ts', 'ts'],
  ['tsx', 'tsx'],
  ['mts', 'ts'],
  ['cts', 'ts'],
  ['js', 'js'],
  ['jsx', 'jsx'],
  ['mjs', 'js'],
  ['cjs', 'js'],
  ['json', 'json'],
  ['jsonc', 'json'],
  ['json5', 'json'],
  ['css', 'css'],
  ['scss', 'scss'],
  ['less', 'less'],
  ['html', 'html'],
  ['htm', 'html'],
  ['xml', 'xml'],
  ['svg', 'xml'],
  ['md', 'markdown'],
  ['markdown', 'markdown'],
  ['mdx', 'markdown'],
  ['py', 'python'],
  ['rb', 'ruby'],
  ['php', 'php'],
  ['java', 'java'],
  ['kt', 'kotlin'],
  ['kts', 'kotlin'],
  ['swift', 'swift'],
  ['go', 'go'],
  ['rs', 'rust'],
  ['c', 'c'],
  ['h', 'c'],
  ['cpp', 'cpp'],
  ['cc', 'cpp'],
  ['hpp', 'cpp'],
  ['cs', 'csharp'],
  ['sql', 'sql'],
  ['lua', 'lua'],
  ['sh', 'bash'],
  ['bash', 'bash'],
  ['zsh', 'bash'],
  ['ps1', 'powershell'],
  ['psm1', 'powershell'],
  ['yml', 'yaml'],
  ['yaml', 'yaml'],
  ['toml', 'toml'],
  ['ini', 'ini'],
  ['dockerfile', 'dockerfile'],
  ['gradle', 'gradle'],
  ['vue', 'html'],
  ['svelte', 'html'],
]);

export function toolActivityCodeLanguage(pathText: string): string {
  const name = String(pathText || '')
    .trim()
    .replace(/[\\/]+$/, '');
  if (!name) return '';
  const base = name.split(/[\\/]/).pop() || '';
  if (/^dockerfile$/i.test(base)) return 'dockerfile';
  const extension = /\.([A-Za-z0-9]+)$/.exec(base);
  return extension ? TOOL_ACTIVITY_CODE_LANGUAGES.get(extension[1].toLowerCase()) || '' : '';
}

// `resultOf`: the earlier call a late result belongs to (mixdog-acp), named by the row's verb instead.
export const TOOL_ACTIVITY_INTERNAL_ARGS = new Set([
  'categoryOrder',
  'loadingTargets',
  'agentBatch',
  'verifyShell',
  'resultOf',
]);

/** Knobs that bound a call (how much, how long) rather than say what it did.
 *  They are never shown: a row of "Limit 45 · Timeout 10s" told the reader
 *  nothing about the work. */
const TOOL_ACTIVITY_OPERATIONAL_ARGS = new Set([
  'limit',
  'head_limit',
  'output_limit',
  'max_results',
  'offset',
  'timeout',
  'timeout_ms',
  'wait_ms',
  // Pure option flags: they switch a behavior on, they name no work.
  'meta',
  'hidden',
  'replace_all',
  'mode',
]);

/** Options that only tune how a given tool searches or pages; named per tool
 *  so a meaningful boolean elsewhere (dry-run, force…) stays visible. */
const TOOL_ACTIVITY_OPERATIONAL_ARGS_BY_TOOL: Record<string, ReadonlySet<string>> = {
  grep: new Set(['include_noise', 'text', 'context', 'type', 'multiline']),
  glob: new Set(['include_noise']),
  find: new Set(['include_noise']),
  list: new Set(['include_noise', 'depth', 'sort']),
  ls: new Set(['include_noise', 'depth', 'sort']),
  read: new Set(['include_noise']),
  code_graph: new Set(['depth', 'include_noise']),
};

export function toolActivityIsOperationalArg(normalizedName: string, key: string): boolean {
  return (
    TOOL_ACTIVITY_OPERATIONAL_ARGS.has(key) || Boolean(TOOL_ACTIVITY_OPERATIONAL_ARGS_BY_TOOL[normalizedName]?.has(key))
  );
}

const MACHINE_ID = /\b[a-z]+_\d{10,}_([0-9a-f]{4,})\b/gi;
const TOOL_USE_ID = /\b(?:task-)?toolu_[A-Za-z0-9]{10,}([A-Za-z0-9]{6})\b/g;

/** `job_1790959235138_971b88` reads as `971b88`, and a tool-use task id
 *  (`task-toolu_01Ghcu…W1Sk2`) by its last six characters: the prefix is
 *  noise and the suffix is what tells two background tasks apart. Short ids
 *  (`a1`) are already readable and stay as they are. */
export function shortMachineId(text: string): string {
  return text.replace(MACHINE_ID, '$1').replace(TOOL_USE_ID, '$1');
}

/** Raw action names the rows of github, browser, office, computer and media
 *  show, in the active language; unknown actions keep their readable form. */
const TOOL_ACTION_LABELS: Record<string, () => string> = {
  issue_list: () => t('List issues'),
  list_issues: () => t('List issues'),
  issue_view: () => t('View issue'),
  view_issue: () => t('View issue'),
  issue_create: () => t('Create issue'),
  create_issue: () => t('Create issue'),
  issue_edit: () => t('Edit issue'),
  edit_issue: () => t('Edit issue'),
  issue_close: () => t('Close issue'),
  close_issue: () => t('Close issue'),
  comment: () => t('Comment'),
  issue_comment: () => t('Comment'),
  issue_comments: () => t('Read comments'),
  pr_comment: () => t('Comment'),
  pr_comments: () => t('Read comments'),
  issue_reopen: () => t('Reopen issue'),
  pr_checkout: () => t('Check out PR'),
  repo_create: () => t('Create repo'),
  repo_clone: () => t('Clone repo'),
  repo_fork: () => t('Fork repo'),
  workflow_run: () => t('Run workflow'),
  run_cancel: () => t('Cancel run'),
  run_rerun: () => t('Rerun'),
  release_list: () => t('List releases'),
  release_view: () => t('View release'),
  release_create: () => t('Create release'),
  release_edit: () => t('Edit release'),
  notification_list: () => t('List notifications'),
  notification_read: () => t('Mark notification read'),
  pr_list: () => t('List PRs'),
  list_prs: () => t('List PRs'),
  pr_view: () => t('View PR'),
  view_pr: () => t('View PR'),
  pr_create: () => t('Create pull request'),
  create_pr: () => t('Create pull request'),
  create_pull_request: () => t('Create pull request'),
  list_pr: () => t('List PRs'),
  edit_document: () => t('Edit document'),
  type_text: () => t('Type text'),
  merge: () => t('Merge PR'),
  pr_merge: () => t('Merge PR'),
  merge_pr: () => t('Merge PR'),
  pr_review: () => t('Review PR'),
  review_pr: () => t('Review PR'),
  repo_list: () => t('List repos'),
  list_repos: () => t('List repos'),
  repo_view: () => t('View repo'),
  view_repo: () => t('View repo'),
  run_list: () => t('List runs'),
  list_runs: () => t('List runs'),
  run_view: () => t('View run'),
  view_run: () => t('View run'),
  run_logs: () => t('Run logs'),
  workflow_list: () => t('List workflows'),
  click: () => t('Click'),
  navigate: () => t('Navigate'),
  type: () => t('Type text'),
  fill: () => t('Type text'),
  screenshot: () => t('Screenshot'),
  scroll: () => t('Scroll'),
  snapshot: () => t('Snapshot'),
  press: () => t('Press key'),
  hover: () => t('Hover'),
  back: () => t('Go back'),
  list_tabs: () => t('List tabs'),
  close_tab: () => t('Close tab'),
  docx_edit: () => t('Edit document'),
  xlsx_edit: () => t('Edit spreadsheet'),
  pptx_edit: () => t('Edit presentation'),
  generate_image: () => t('Generate image'),
  generate_video: () => t('Generate video'),
  generate: () => t('Generate'),
  capture: () => t('Capture'),
  launch: () => t('Launch'),
  diagnose: () => t('Diagnose'),
  verify: () => t('Verify'),
  // browser / browser_devtools
  locate: () => t('Locate element'),
  evaluate: () => t('Run script'),
  select: () => t('Select option'),
  drag: () => t('Drag'),
  upload: () => t('Upload file'),
  handle_dialog: () => t('Answer dialog'),
  sequence: () => t('Run steps'),
  extract: () => t('Extract'),
  console: () => t('Console logs'),
  network: () => t('Network requests'),
  downloads: () => t('Downloads'),
  hide: () => t('Hide panel'),
  emulate: () => t('Emulate device'),
  cookies: () => t('Cookies'),
  storage: () => t('Storage'),
  intercept: () => t('Intercept requests'),
  init_script: () => t('Init script'),
  performance: () => t('Performance'),
  get: () => t('Get'),
  set: () => t('Set'),
  clear: () => t('Clear'),
  add: () => t('Add'),
  // computer
  wait_for_user: () => t('Wait for user'),
  act: () => t('Operate'),
  window: () => t('Window'),
  menu: () => t('Menu'),
  clipboard: () => t('Clipboard'),
  saved_login: () => t('Saved login'),
  focus: () => t('Focus'),
  // terminal / tidy
  run: () => t('Run'),
  fix: () => t('Fix'),
  scan: () => t('Scan'),
  check: () => t('Check'),
  rules: () => t('Rules'),
  results: () => t('Results'),
  // office
  detect: () => t('Detect'),
  transactions: () => t('Transactions'),
  recover: () => t('Recover'),
  describe: () => t('Describe'),
  author: () => t('Write document'),
  create: () => t('Create'),
  attach: () => t('Attach'),
  secure: () => t('Secure'),
  begin: () => t('Begin'),
  query: () => t('Search'),
  batch: () => t('Batch edit'),
  diff: () => t('Compare'),
  commit: () => t('Commit'),
  rollback: () => t('Roll back'),
  issues: () => t('Issues'),
  qa: () => t('Review'),
  validate: () => t('Validate'),
  render: () => t('Render'),
  finalize: () => t('Finalize'),
  // goal
  complete: () => t('Complete'),
  block: () => t('Block'),
  extend: () => t('Extend'),
  abandon: () => t('Abandon'),
  update_tasks: () => t('Update tasks'),
  set_tasks: () => t('Set tasks'),
  // todo
  init: () => t('Start'),
  advance: () => t('Advance'),
  done: () => t('Mark done'),
  start: () => t('Start'),
  drop: () => t('Drop'),
  append: () => t('Add steps'),
  rm: () => t('Remove'),
  view: () => t('View'),
  unblock: () => t('Unblock'),
  // setup
  set_route: () => t('Set route'),
  list_models: () => t('List models'),
  add_mcp_server: () => t('Add MCP server'),
  save_automation: () => t('Save automation'),
  delete_automation: () => t('Delete automation'),
  run_automation: () => t('Run automation'),
  set_automation_enabled: () => t('Turn automation on or off'),
  read_definition: () => t('Read definition'),
  save_definition: () => t('Save definition'),
  set_appearance: () => t('Set appearance'),
  install_builtin: () => t('Install built-in'),
  set_disabled_skills: () => t('Set disabled skills'),
  save_project: () => t('Save project'),
  // session
  bots: () => t('Bots'),
  suggest: () => t('Suggestions'),
  list_worktrees: () => t('List worktrees'),
  // setup
  set_agent_route: () => t('Set agent route'),
  set_web_search_route: () => t('Set web search route'),
  set_workflow: () => t('Set workflow'),
  set_output_style: () => t('Set output style'),
  set_profile: () => t('Set profile'),
  set_autoclear: () => t('Set auto clear'),
  set_compaction: () => t('Set compaction'),
  set_memory_enabled: () => t('Turn memory on or off'),
  set_recap_enabled: () => t('Turn recap on or off'),
  set_web_search_enabled: () => t('Turn web search on or off'),
  set_instruction_files: () => t('Set instruction files'),
  set_auto_effort_base: () => t('Set auto effort'),
  set_builtin_enabled: () => t('Turn built-in on or off'),
  install_local_model: () => t('Install local model'),
  start_local_installation: () => t('Start local install'),
  cancel_local_installation: () => t('Cancel local install'),
  set_local_idle_ttl: () => t('Set local model idle time'),
  search_local_models: () => t('Search local models'),
  inspect_hf_model: () => t('Inspect Hugging Face model'),
  register_hf_model: () => t('Register Hugging Face model'),
  local_model_details: () => t('Local model details'),
  maintain_local_model: () => t('Maintain local model'),
  delete_local_model: () => t('Delete local model'),
  set_system_shell: () => t('Set system shell'),
  set_auto_update: () => t('Set auto update'),
  set_ai_session_titles: () => t('Set AI session titles'),
  set_quota_auto_resume: () => t('Set quota auto resume'),
  set_model_preferences: () => t('Set model preferences'),
  set_heartbeat_enabled: () => t('Turn heartbeat on or off'),
  set_heartbeat_interval: () => t('Set heartbeat interval'),
  set_reactions_enabled: () => t('Turn reactions on or off'),
  forget_provider_auth: () => t('Forget provider sign-in'),
  set_provider_account: () => t('Set provider account'),
  save_mcp_server: () => t('Save MCP server'),
  remove_mcp_server: () => t('Remove MCP server'),
  set_mcp_enabled: () => t('Turn MCP server on or off'),
  reconnect_mcp: () => t('Reconnect MCP server'),
  set_extension_scope: () => t('Set extension scope'),
  add_plugin: () => t('Add plugin'),
  update_plugin: () => t('Update plugin'),
  set_plugin_enabled: () => t('Turn plugin on or off'),
  remove_plugin: () => t('Remove plugin'),
  enable_plugin_mcp: () => t('Enable plugin MCP'),
  connect_connector: () => t('Connect connector'),
  set_worktree_settings: () => t('Set worktree settings'),
  set_network_proxy: () => t('Set network proxy'),
  reset_route_fallback: () => t('Reset route fallback'),
  continue_in_model: () => t('Continue in another model'),
  schedule_quota_resume: () => t('Schedule quota resume'),
  cancel_quota_resume: () => t('Cancel quota resume'),
  set_cache_warming_enabled: () => t('Turn cache warming on or off'),
  read_agent_settings: () => t('Read agent settings'),
  read_project_connectors: () => t('Read project connectors'),
  set_agent_permission: () => t('Set agent permission'),
  set_agent_connector: () => t('Set agent connector'),
  set_agent_connector_tool: () => t('Set agent connector tool'),
  set_project_connector: () => t('Set project connector'),
  restore_definition: () => t('Restore definition'),
  set_bot_order: () => t('Set bot order'),
  set_local_context: () => t('Set local context'),
  set_orchestration_mode: () => t('Set orchestration mode'),
  get_mcp_server: () => t('Read MCP server'),
  create_definition: () => t('Create definition'),
  delete_definition: () => t('Delete definition'),
  set_webhook_config: () => t('Set webhook'),
  set_desktop_settings: () => t('Set desktop settings'),
  remove_project: () => t('Remove project'),
  revoke_linked_device: () => t('Revoke linked device'),
  set_activity_rail_pins: () => t('Set activity bar pins'),
  set_developer_option: () => t('Set developer option'),
  add_hook_rule: () => t('Add hook rule'),
  set_hook_rule_enabled: () => t('Turn hook rule on or off'),
  delete_hook_rule: () => t('Delete hook rule'),
  set_media_default: () => t('Set media default'),
  // computer window operations and list kinds
  maximize: () => t('Maximize'),
  minimize: () => t('Minimize'),
  move: () => t('Move'),
  restore: () => t('Restore'),
  terminate: () => t('Terminate'),
  windows: () => t('Windows'),
  apps: () => t('Apps'),
  history: () => t('History'),
  // code_graph modes
  overview: () => t('Overview'),
  imports: () => t('Imports'),
  dependents: () => t('Dependents'),
  impact: () => t('Impact'),
  related: () => t('Related files'),
  symbols: () => t('Symbols'),
  find_symbol: () => t('Find symbol'),
  symbol_search: () => t('Symbol search'),
  references: () => t('References'),
  // visualize
  annotate: () => t('Annotate'),
  export: () => t('Export'),
  inspect: () => t('Inspect'),
  // code_graph
  callers: () => t('Callers'),
  callees: () => t('Callees'),
};

const actionKey = (action: string): string => action.toLowerCase().replace(/[.\s-]+/g, '_');

/** The call's action word in the active language where the catalog carries
 *  one, else a readable form of the raw word (`pr.list` → `pr list`). */
export function toolActivityActionLabel(action: string): string {
  const known = TOOL_ACTION_LABELS[actionKey(action)];
  if (known) return known();
  switch (action.toLowerCase()) {
    case 'wait':
      return t('Wait');
    case 'read':
      return t('Read');
    case 'cancel':
      return t('Cancel');
    case 'list':
      return t('List');
    case 'status':
      return t('Status');
    case 'open':
      return t('Open');
    case 'search':
      return t('Search');
    case 'preview':
      return t('Preview');
    case 'install':
      return t('Install');
    case 'save':
    case 'write':
      return t('Save');
    case 'delete':
    case 'remove':
    case 'forget':
      return t('Delete');
    case 'update':
      return t('Update');
    case 'stage':
      return t('Stage');
    case 'close':
      return t('Close');
    case 'resume':
      return t('Resume');
    case 'spawn':
      return t('Spawn');
    case 'send':
      return t('Send');
    case 'cleanup':
      return t('Cleanup');
    case 'response':
      return t('Response');
    default:
      return action.replace(/[._-]+/g, ' ').trim();
  }
}

/** A summary that opens with the raw action (`navigate · example.com`) opens
 *  with its localized word instead. */
function localizeActionSubject(args: Record<string, unknown>, fallback: string): string {
  const action = toolActivityFirstText(args, 'action');
  if (!action) return fallback;
  if (fallback === action) return toolActivityActionLabel(action);
  if (fallback.startsWith(`${action} · `)) return `${toolActivityActionLabel(action)}${fallback.slice(action.length)}`;
  // The shared summary may already name the action in English ("List issues").
  const head = fallback.split(' · ')[0];
  const known =
    TOOL_ACTION_LABELS[
      head
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
    ];
  return known ? `${known()}${fallback.slice(head.length)}` : fallback;
}

/** GitHub rows name the localized action, then the target as its own parts
 *  (number, repo, title), instead of rewriting the English summary. */
function githubSubject(args: Record<string, unknown>, fallback: string): string {
  const action = toolActivityFirstText(args, 'action');
  if (!TOOL_ACTION_LABELS[actionKey(action)]) return localizeActionSubject(args, fallback);
  const id = toolActivityFirstText(args, 'number', 'id');
  const title = toolActivityFirstText(args, 'title', 'workflow', 'tag');
  return toolActivityCompact([
    toolActivityActionLabel(action),
    id ? `#${id}` : '',
    toolActivityFirstText(args, 'repo'),
    title.length > 60 ? `${title.slice(0, 59)}…` : title,
  ]);
}

const WEB_SCHEME = /\bhttps?:\/\/(?:www\.)?/g;

/** "Navigate · example.com/a (tab capcheck)": the action, its devtools
 *  operation, the page or element it acted on, and the tab. */
function browserSubject(args: Record<string, unknown>, fallback: string): string {
  const action = toolActivityFirstText(args, 'action');
  if (!action) return localizeActionSubject(args, fallback.replace(WEB_SCHEME, ''));
  const operation = toolActivityFirstText(args, 'operation');
  const target = toolActivityInline(toolActivityFirstText(args, 'url', 'ref', 'selector'), 300).replace(WEB_SCHEME, '');
  const tab = toolActivityFirstText(args, 'tab');
  const subject = toolActivityCompact([
    toolActivityActionLabel(action),
    operation ? toolActivityActionLabel(operation) : '',
    target,
  ]);
  return tab ? `${subject} (${t('Tab {{value0}}', { value0: tab })})` : subject;
}

/** "Window · Close · hwnd:0x1020076": the action, then its one target. */
function computerSubject(args: Record<string, unknown>, fallback: string): string {
  const action = toolActivityFirstText(args, 'action');
  if (!action) return localizeActionSubject(args, fallback);
  const operation = toolActivityFirstText(args, 'operation');
  const detail = operation || toolActivityFirstText(args, 'kind');
  return toolActivityCompact([
    toolActivityActionLabel(action),
    detail ? toolActivityActionLabel(detail) : '',
    toolActivityInline(toolActivityFirstText(args, 'ref', 'window_id', 'app'), 300),
  ]);
}

const SUBJECT_TEXT_MAX = 80;

function clippedText(value: string): string {
  return value.length > SUBJECT_TEXT_MAX ? `${value.slice(0, SUBJECT_TEXT_MAX - 1)}…` : value;
}

/** Each memory op has its own row verb ("Memory saving"), so the subject is
 *  what was saved, looked up or deleted. */
function memorySubject(args: Record<string, unknown>): string {
  const id = toolActivityFirstText(args, 'id');
  return toolActivityCompact([
    id ? `#${id}` : '',
    clippedText(toolActivityInline(toolActivityFirstText(args, 'summary', 'text', 'query', 'value', 'key', 'name'))),
  ]);
}

/** A recall names its ids and queries; its result limit is a knob, not the work. */
function recallSubject(args: Record<string, unknown>): string {
  const ids = (Array.isArray(args.id) ? args.id : [args.id])
    .filter((id) => id != null && String(id).trim())
    .map((id) => String(id).trim());
  return toolActivityCompact([
    ids.map((id) => `#${id}`).join(', '),
    toolActivityOneOrCount(toolActivityValues(args.query ?? args.text ?? args.input), 'query', toolActivityQuoted),
  ]);
}

/** Every media action has its own row verb ("Image generation", "Media
 *  catalog"), so the subject names only what it acted on. */
function mediaSubject(args: Record<string, unknown>): string {
  const action = toolActivityFirstText(args, 'action').toLowerCase();
  const kind = toolActivityFirstText(args, 'kind').toLowerCase();
  let kindLabel = kind;
  if (kind === 'video') kindLabel = t('Video');
  else if (kind === 'image') kindLabel = t('Image');
  return toolActivityCompact([
    // A generation's verb already names its kind.
    /^generate/.test(action) ? '' : kindLabel,
    toolActivityFirstText(args, 'path', 'job', 'job_id', 'id'),
  ]);
}

/** The tidy actions whose row verb is the action itself ("Tidy scan", "Tidy install"). */
const TIDY_VERB_ACTIONS = new Set(['install', 'fix', 'scan', 'check', 'rules', 'results']);

/** "biome · src": the engines and paths. The row verb names the action; only
 *  one it has no verb for is said here. */
function tidySubject(args: Record<string, unknown>): string {
  const action = toolActivityFirstText(args, 'action').toLowerCase();
  return toolActivityCompact([
    !action || TIDY_VERB_ACTIONS.has(action) ? '' : toolActivityActionLabel(action),
    toolActivityStringList(args.engines).join(', '),
    toolActivityOneOrCount(toolActivityStringList(args.paths), 'path'),
  ]);
}

/** "Run · npm run dev", "Tab 2": a run names its command, a read its tab. */
function terminalSubject(args: Record<string, unknown>): string {
  const action = toolActivityFirstText(args, 'action').toLowerCase();
  if (action === 'run') return toolActivityInline(toolActivityFirstText(args, 'command'), 1_000);
  const tab = toolActivityFirstText(args, 'tab');
  return action === 'read' && tab ? t('Tab {{value0}}', { value0: tab }) : '';
}

/** "Complete", "Create · <objective>": the goal action and what it states. */
function goalSubject(args: Record<string, unknown>): string {
  const action = toolActivityFirstText(args, 'action');
  return toolActivityCompact([
    action ? toolActivityActionLabel(action) : '',
    clippedText(toolActivityInline(toolActivityFirstText(args, 'objective', 'blocker'))),
  ]);
}

/** "Advance · <note>", "Set · 7 steps": the plan operation and the step it
 *  names. A view's row verb ("Plan view") already is the operation. */
function todoSubject(args: Record<string, unknown>): string {
  const op = toolActivityFirstText(args, 'op');
  const items = Array.isArray(args.items) ? args.items : [];
  const only = items.length === 1 ? asRecord(items[0]) : null;
  let step = '';
  if (only) step = toolActivityFirstText(only, 'content', 'text');
  else if (items.length === 1) step = String(items[0]);
  const target = toolActivityFirstText(args, 'item', 'note', 'reason') || step;
  let named = '';
  if (target) named = clippedText(toolActivityInline(target));
  else if (items.length > 1) named = t('{{count}} steps', { count: items.length });
  return toolActivityCompact([op && op.toLowerCase() !== 'view' ? toolActivityActionLabel(op) : '', named]);
}

/** "Sign in · GitHub Device Activation": what the user is asked to do, and where. */
function handoffSubject(args: Record<string, unknown>): string {
  const handoff = asRecord(args.handoff) ?? {};
  const kind = toolActivityFirstText(handoff, 'kind');
  const need = toolActivityFirstText(handoff, 'need');
  let ask = '';
  if (kind === 'secret') ask = t('Enter a secret');
  else if (need === 'sign_in' || toolActivityFirstText(handoff, 'purpose') === 'login') ask = t('Sign in');
  else if (need === 'confirmation') ask = t('Confirm identity');
  else if (kind) ask = t('Human step');
  return toolActivityCompact([
    ask,
    clippedText(toolActivityInline(toolActivityFirstText(handoff, 'target', 'field', 'app', 'url'))),
  ]);
}

/** `search_emails · from:boss` reads "Search emails · from:boss". */
export function mcpToolSubject(tool: string, fallback: string): string {
  const name = tool.replace(/[_-]+/g, ' ').trim();
  if (!tool || !fallback.startsWith(tool) || !name) return fallback;
  return `${name[0].toUpperCase()}${name.slice(1)}${fallback.slice(tool.length)}`;
}

export const TOOL_ACTIVITY_BULK_ARGS = new Set([
  'old_string',
  'new_string',
  'oldString',
  'newString',
  'old_str',
  'new_str',
  'content',
  'patch',
]);

const TOOL_ACTIVITY_SECRET_ARG = /(?:password|secret|token|api[_-]?key|authorization|cookie)/i;
export const TOOL_ACTIVITY_ROUTINE_RESULT =
  /^(?:ok|done|success(?:ful)?|completed|finished|updated|written|applied|saved|loaded|cancelled)[.!]?$/i;
export const TOOL_ACTIVITY_MEANINGLESS_RESULT =
  /^(?:ok|done|success(?:ful)?|completed|finished|updated|written|applied|loaded)[.!]?$/i;

export function toolActivityInline(value: unknown, max = 500): string {
  return oneLine(boundedTextOf(value, max)).trim();
}

export function toolActivityFirstText(args: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return '';
}

function toolActivityStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (typeof entry === 'string') return entry.trim();
      // `read` accepts `{file_path, offset, limit}` entries; name them by path.
      if (entry && typeof entry === 'object') {
        return toolActivityFirstText(entry as Record<string, unknown>, 'file_path', 'filePath', 'path');
      }
      return '';
    })
    .filter(Boolean);
}

export function toolActivityCompact(parts: Array<string | undefined>): string {
  return parts
    .map((part) => String(part || '').trim())
    .filter(Boolean)
    .join(' · ');
}

function toolActivityQuoted(value: unknown): string {
  const text = toolActivityInline(value, 300);
  return text ? `"${text}"` : '';
}

export function toolActivityCommand(args: Record<string, unknown>): string {
  const direct = toolActivityFirstText(args, 'command', 'cmd', 'description');
  if (direct) return direct;
  const commands = toolActivityStringList(args.commands ?? args.command);
  return commands.join('\n');
}

function toolActivityPath(args: Record<string, unknown>): string {
  return toolActivityFirstText(args, 'file_path', 'filePath', 'path', 'file', 'target');
}

/** A batch argument as its entries: a string is one entry, an array each. */
function toolActivityValues(value: unknown): string[] {
  if (typeof value === 'string') return value.trim() ? [value.trim()] : [];
  return toolActivityStringList(value);
}

type ToolActivityTargetNoun = 'file' | 'pattern' | 'query' | 'command' | 'URL' | 'path' | 'symbol' | 'change';

function toolActivityTargetCount(noun: ToolActivityTargetNoun, count: number): string {
  switch (noun) {
    case 'file':
      return t('{{count}} files', { count });
    case 'pattern':
      return t('{{count}} patterns', { count });
    case 'query':
      return t('{{count}} queries', { count });
    case 'command':
      return t('{{count}} commands', { count });
    case 'URL':
      return t('{{count}} URLs', { count });
    case 'path':
      return t('{{count}} paths', { count });
    case 'change':
      return t('{{count}} changes', { count });
    default:
      return t('{{count}} symbols', { count });
  }
}

/** One target reads as itself, several as a count ("3 files"). */
function toolActivityOneOrCount(
  values: string[],
  noun: ToolActivityTargetNoun,
  format: (value: string) => string = (value) => toolActivityInline(value)
): string {
  if (values.length > 1) return toolActivityTargetCount(noun, values.length);
  return values.length ? format(values[0]) : '';
}

/** `path:start-end`: the line window in the reference form paths already use. */
function readTarget(path: string, offsetValue: unknown, limitValue: unknown): string {
  const offset = Number(offsetValue);
  const limit = Number(limitValue);
  const hasOffset = Number.isFinite(offset) && offset > 0;
  const hasLimit = Number.isFinite(limit) && limit > 0;
  const start = hasOffset ? Math.floor(offset) : 1;
  let window = '';
  if (hasLimit) window = `:${start}-${start + Math.floor(limit) - 1}`;
  else if (hasOffset) window = `:${start}+`;
  return path ? `${path}${window}` : '';
}

function readTargets(args: Record<string, unknown>): string[] {
  const value = args.file_path ?? args.path;
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (typeof entry === 'string') return entry.trim();
      if (!entry || typeof entry !== 'object') return '';
      const record = entry as Record<string, unknown>;
      return readTarget(
        toolActivityFirstText(record, 'file_path', 'filePath', 'path'),
        record.offset ?? args.offset,
        record.limit ?? args.limit
      );
    })
    .filter(Boolean);
}

// One entry per normalized tool name, shared by every name in a group.
function byToolName<T>(groups: Array<[names: string[], value: T]>): Record<string, T> {
  const table: Record<string, T> = {};
  for (const [names, value] of groups) {
    for (const name of names) table[name] = value;
  }
  return table;
}

type ToolSubjectFormatter = (args: Record<string, unknown>, path: string, fallback: string) => string;

function readSubject(args: Record<string, unknown>, path: string): string {
  const paths = readTargets(args);
  if (paths.length > 1) return toolActivityTargetCount('file', paths.length);
  // A batch entry already carries its own window; only a plain path takes the call's.
  if (paths.length === 1) return paths[0];
  return readTarget(path, args.offset, args.limit);
}

function grepSubject(args: Record<string, unknown>): string {
  return toolActivityCompact([
    toolActivityOneOrCount(toolActivityValues(args.pattern ?? args.query), 'pattern', toolActivityQuoted),
    toolActivityOneOrCount(toolActivityValues(args.path), 'path'),
    args.glob ? toolActivityInline(args.glob) : '',
  ]);
}

function globSubject(args: Record<string, unknown>): string {
  return toolActivityCompact([
    toolActivityOneOrCount(toolActivityValues(args.pattern ?? args.glob), 'pattern'),
    toolActivityOneOrCount(toolActivityValues(args.path), 'path'),
  ]);
}

function findSubject(args: Record<string, unknown>): string {
  return toolActivityCompact([
    toolActivityOneOrCount(toolActivityValues(args.query ?? args.fuzzy), 'query', toolActivityQuoted),
    toolActivityOneOrCount(toolActivityValues(args.path), 'path'),
  ]);
}

function codeGraphSubject(args: Record<string, unknown>): string {
  const mode = toolActivityInline(args.mode ?? args.action ?? '');
  // callers/callees name the direction of the walk; the target alone hides it.
  const direction = /^(?:callers|callees)$/.test(mode) ? toolActivityActionLabel(mode) : '';
  const targets = toolActivityCompact([
    toolActivityOneOrCount(toolActivityValues(args.symbols ?? args.symbol), 'symbol'),
    toolActivityOneOrCount(toolActivityValues(args.files ?? args.file ?? args.path), 'file'),
  ]);
  return toolActivityCompact([direction, targets || toolActivityQuoted(args.query)]) || toolActivityActionLabel(mode);
}

function commandSubject(args: Record<string, unknown>): string {
  const commands = toolActivityValues(args.commands ?? args.command);
  if (commands.length > 1) return toolActivityTargetCount('command', commands.length);
  return toolActivityInline(toolActivityCommand(args), 1_000);
}

/** The row verb already says "Questions": the subject is what was asked. */
function questionsSubject(args: Record<string, unknown>): string {
  const questions = Array.isArray(args.questions) ? args.questions : [];
  const asked = questions
    .map((entry) => toolActivityFirstText(asRecord(entry) ?? {}, 'header', 'question'))
    .filter(Boolean);
  return clippedText(asked.join(', '));
}

const TOOL_SUBJECTS = byToolName<ToolSubjectFormatter>([
  [['read'], readSubject],
  [['view_image', 'read_mcp_resource'], (args, path) => path || toolActivityFirstText(args, 'uri')],
  [['edit', 'strreplace', 'str_replace', 'str_replace_editor', 'search_replace'], (_args, path) => path],
  [['apply_patch'], (_args, _path, fallback) => fallback],
  [['shell', 'bash', 'bash_session', 'shell_command', 'job_wait'], commandSubject],
  // A stage call has no command: its summary names the staged changes.
  [
    ['git'],
    (args) =>
      args.action === 'stage'
        ? toolActivityOneOrCount(toolActivityValues(args.change_ids ?? args.change_id), 'change')
        : (args.action === 'worktree' && gitWorktreeSubject(args)) || commandSubject(args),
  ],
  [['git_stage'], (args) => toolActivityOneOrCount(toolActivityValues(args.files ?? args.paths), 'file')],
  [['grep'], grepSubject],
  [['glob'], globSubject],
  [['find'], findSubject],
  [['code_graph'], codeGraphSubject],
  [
    ['list', 'ls'],
    // The entry limit is an argument, not what was listed: beside the result
    // count it read as a second, contradicting total ("80 entries 81 entries").
    (args) => toolActivityOneOrCount(toolActivityValues(args.path ?? args.dir ?? args.cwd), 'path'),
  ],
  [
    ['web_search', 'web_search_call', 'search_query', 'image_query'],
    (args) =>
      toolActivityOneOrCount(
        toolActivityValues(args.query ?? args.queries ?? args.keywords),
        'query',
        toolActivityQuoted
      ),
  ],
  [
    ['web_fetch', 'fetch'],
    (args, _path, fallback) =>
      toolActivityOneOrCount(toolActivityValues(args.url ?? args.urls ?? args.uri), 'URL', (value) =>
        toolActivityInline(value, 1_000)
      ) || fallback,
  ],
  [
    ['load_tool'],
    (args, _path, fallback) => {
      const names = [...toolActivityValues(args.names), ...toolActivityValues(args.select)];
      return names.join(', ') || fallback;
    },
  ],
  [['skill', 'skill_execute', 'skill_view', 'skills_list', 'use_skill', 'update_plan'], () => ''],
  [
    ['task'],
    (args) =>
      toolActivityCompact([
        toolActivityActionLabel(toolActivityFirstText(args, 'action')),
        shortMachineId(toolActivityFirstText(args, 'task_id', 'id')),
      ]),
  ],
  [
    ['agent', 'bridge'],
    (args, _path, fallback) =>
      shortMachineId(toolActivityFirstText(args, 'description', 'tag', 'role', 'model') || fallback),
  ],
  [['github'], (args, _path, fallback) => githubSubject(args, fallback)],
  [['session'], (args, _path, fallback) => sessionSubject(args, fallback)],
  [['request_user_input'], questionsSubject],
  // "Open · example.com/path": the scheme says nothing on a browser row.
  [['browser', 'browser_devtools'], (args, _path, fallback) => browserSubject(args, fallback)],
  [['computer'], (args, _path, fallback) => computerSubject(args, fallback)],
  [['memory', 'remember', 'save_memory', 'update_memory'], memorySubject],
  [['recall', 'recall_memory', 'search_memories'], recallSubject],
  [['media'], mediaSubject],
  [['tidy'], tidySubject],
  [['terminal'], terminalSubject],
  [['goal'], goalSubject],
  [['todo'], todoSubject],
  [['react'], (args) => toolActivityFirstText(args, 'emoji')],
  [['handoff_user'], handoffSubject],
  // "주문 처리 흐름", "mockup.html", "shots/home.png": the tab's title, else
  // what the call acted on. The arguments arrive as the unwrapped `input`
  // (the action rides beside it), so an action shows only when flat.
  [
    ['visualize'],
    (args, _path, fallback) => visualizeRowSubject(toolActivityFirstText(args, 'action'), args, '') || fallback,
  ],
  [['setup', 'office'], (args, _path, fallback) => localizeActionSubject(args, fallback)],
]);

/** "Rename session: Fix login", "Fork into new session", "Set project · C:\repo":
 *  the session tool's action as a short label, with what it acted on. */
function sessionSubject(args: Record<string, unknown>, fallback: string): string {
  const action = toolActivityFirstText(args, 'action').toLowerCase();
  const title = toolActivityFirstText(args, 'title');
  const path = toolActivityFirstText(args, 'path');
  switch (action) {
    // The row verb ("Session status", "Project listing", "Project selection",
    // "Session creation") already is the action.
    case 'status':
    case 'list-projects':
      return '';
    case 'create':
      return title;
    case 'rename':
      return title ? `${t('Rename session')}: ${title}` : t('Rename session');
    case 'compact':
      return t('Compact session');
    case 'fork':
      return t('Fork into new session');
    case 'set-project':
      return path;
    case 'favorite':
      return args.value === false ? t('Remove from favorites') : t('Add to favorites');
    case 'archive':
      return args.value === false ? t('Unarchive session') : t('Archive session');
    default:
      return action ? toolActivityActionLabel(action) : fallback;
  }
}

/** The git tool's `worktree` action as a short label, by its `worktree_action`;
 *  '' for any other (the command line then names the call). */
function gitWorktreeSubject(args: Record<string, unknown>): string {
  switch (toolActivityFirstText(args, 'worktree_action').toLowerCase()) {
    case 'enter':
      return t('Enter worktree');
    case 'return':
      return t('Return to project folder');
    case 'merge':
      return t('Merge worktree');
    case 'remove':
      return t('Remove worktree');
    case 'list':
      return t('List worktrees');
    case 'prune':
      return t('Prune worktrees');
    default:
      return '';
  }
}

/** The visualize tool's actions as past-tense verbs in the active language. */
function visualizeActionLabel(action: string): string {
  switch (action.toLowerCase()) {
    case 'open':
      return t('Showed tab');
    case 'close':
      return t('Closed tab');
    case 'check':
      return t('Checked tab');
    case 'capture':
      return t('Captured tab');
    case 'annotate':
      return t('Annotated tab');
    case 'export':
      return t('Exported tab');
    case 'inspect':
      return t('Inspected tab');
    case 'act':
      return t('Operated tab');
    default:
      return action ? toolActivityActionLabel(action) : '';
  }
}

/** The action verb, then the tab's title (`tabTitle`), else what the call
 *  acted on; a bare tab id is never shown. `args` is the call's `input`. */
export function visualizeRowSubject(action: string, args: Record<string, unknown>, tabTitle: string): string {
  const content = asRecord(args.content);
  const kind = VISUALIZE_INLINE_KINDS.find((candidate) => candidate === content?.kind);
  const subject =
    toolActivityFirstText(args, 'label') ||
    (content ? toolActivityFirstText(content, 'title') : '') ||
    toolActivityOneOrCount(toolActivityValues(args.targets), 'path') ||
    tabTitle ||
    toolActivityFirstText(args, 'output') ||
    (kind ? visualizeInlineKindLabel(kind) : '');
  return toolActivityCompact([visualizeActionLabel(action), subject]);
}

export function toolActivitySubject(normalizedName: string, args: Record<string, unknown>, fallback: string): string {
  const format = TOOL_SUBJECTS[normalizedName];
  return format ? format(args, toolActivityPath(args), fallback) : fallback;
}

/** A call's batchable arguments, one list per argument (patterns, paths…). */
type ToolTargetsFormatter = (args: Record<string, unknown>) => string[][];

// Each entry of a batch call, listed in the detail view only when one call
// carried several targets (the row itself then reads "3 files").
const TOOL_TARGETS = byToolName<ToolTargetsFormatter>([
  [['read'], (args) => [readTargets(args)]],
  [
    ['grep'],
    (args) => [toolActivityValues(args.pattern ?? args.query).map(toolActivityQuoted), toolActivityValues(args.path)],
  ],
  [['glob'], (args) => [toolActivityValues(args.pattern ?? args.glob), toolActivityValues(args.path)]],
  [
    ['find'],
    (args) => [toolActivityValues(args.query ?? args.fuzzy).map(toolActivityQuoted), toolActivityValues(args.path)],
  ],
  [
    ['code_graph'],
    (args) => [
      toolActivityValues(args.symbols ?? args.symbol),
      toolActivityValues(args.files ?? args.file ?? args.path),
    ],
  ],
  [['list', 'ls'], (args) => [toolActivityValues(args.path ?? args.dir ?? args.cwd)]],
  [
    ['shell', 'bash', 'bash_session', 'shell_command', 'job_wait', 'git'],
    (args) => [toolActivityValues(args.commands ?? args.command)],
  ],
  [['git_stage'], (args) => [toolActivityValues(args.files ?? args.paths)]],
  [
    ['web_search', 'web_search_call', 'search_query', 'image_query'],
    (args) => [toolActivityValues(args.query ?? args.queries ?? args.keywords).map(toolActivityQuoted)],
  ],
  [['web_fetch', 'fetch'], (args) => [toolActivityValues(args.url ?? args.urls ?? args.uri)]],
  [['visualize'], (args) => [toolActivityValues(args.targets)]],
]);

/** Every entry of each argument that carried more than one; empty when none did. */
export function toolActivityTargets(normalizedName: string, args: Record<string, unknown>): string[] {
  return (TOOL_TARGETS[normalizedName]?.(args) ?? []).filter((values) => values.length > 1).flat();
}

export function toolActivityFieldLabel(key: string, normalizedName = ''): string {
  if (normalizedName === 'github' && key === 'title') return t('Pull request title');
  const labels: Record<string, string> = {
    api_key: t('API key'),
    include_noise: t('Include ignored'),
    timeout_ms: t('Timeout'),
  };
  if (labels[key]) return labels[key];
  const text = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim();
  return text ? t(`${text[0].toUpperCase()}${text.slice(1)}`) : key;
}

export function toolActivityFieldValue(key: string, value: unknown): string {
  if (TOOL_ACTIVITY_SECRET_ARG.test(key)) return '••••••';
  if (key === 'timeout_ms' && Number(value) > 0) {
    return formatElapsed(Number(value));
  }
  if (typeof value === 'boolean') return value ? t('Yes') : t('No');
  if (Array.isArray(value) && value.every((entry) => typeof entry === 'string')) {
    return shortMachineId(value.join(', '));
  }
  if (value && typeof value === 'object') {
    try {
      return JSON.stringify(value, null, 2).slice(0, 8_000);
    } catch {
      // Cyclic or non-JSON values fall back to the bounded text serializer.
    }
  }
  return shortMachineId(boundedTextOf(value, 8_000));
}

export function toolActivityRedactInlineSecrets(text: string, args: Record<string, unknown>): string {
  let redacted = text;
  for (const [key, value] of Object.entries(args)) {
    if (!TOOL_ACTIVITY_SECRET_ARG.test(key) || value == null || typeof value === 'object') continue;
    const raw = toolActivityInline(value);
    if (!raw) continue;
    redacted = redacted.split(`${key}=${raw}`).join(`${key}=••••••`).split(`${key}: ${raw}`).join(`${key}: ••••••`);
  }
  return redacted;
}

// Argument keys the activity line already shows for each normalized tool
// name; the detail view skips them.
const TOOL_REPRESENTED_KEYS = byToolName<readonly string[]>([
  [['read'], ['file_path', 'filePath', 'path', 'file', 'offset', 'limit', 'pages']],
  [
    ['view_image', 'read_mcp_resource'],
    ['file_path', 'filePath', 'path', 'file', 'uri'],
  ],
  [
    ['edit', 'strreplace', 'str_replace', 'str_replace_editor', 'search_replace'],
    ['file_path', 'filePath', 'path', 'file', 'target'],
  ],
  [
    ['shell', 'bash', 'bash_session', 'shell_command', 'job_wait', 'git'],
    [
      'command',
      'commands',
      'cmd',
      'description',
      'action',
      'type',
      'status',
      'surface',
      'operation',
      'label',
      'task_id',
    ],
  ],
  [['git_stage'], ['files', 'paths']],
  [['github', 'setup', 'tidy', 'office', 'computer', 'media'], ['action']],
  [['visualize'], ['action', 'targets', 'tab', 'output', 'label', 'content']],
  // The row's subject already names the page / element the call acted on.
  [
    ['browser', 'browser_devtools'],
    ['action', 'url', 'uri', 'ref', 'selector'],
  ],
  [['grep'], ['pattern', 'query', 'path', 'glob']],
  [['glob'], ['pattern', 'glob', 'path']],
  [['find'], ['query', 'fuzzy', 'path']],
  [
    ['list', 'ls'],
    ['path', 'dir', 'cwd'],
  ],
  [
    ['web_search', 'web_search_call', 'search_query', 'image_query'],
    ['query', 'queries', 'keywords'],
  ],
  [
    ['web_fetch', 'fetch'],
    ['url', 'urls', 'uri'],
  ],
  [['load_tool'], ['names', 'select', 'query', 'q', 'text']],
  [
    ['skill', 'skill_execute', 'skill_view', 'skills_list', 'use_skill'],
    ['name', 'skill', 'skill_name', 'query', 'q'],
  ],
  [['task'], ['action', 'task_id', 'id', 'type', 'status', 'surface', 'operation', 'label']],
  [
    ['agent', 'bridge'],
    [
      'type',
      'action',
      'description',
      'tag',
      'role',
      'model',
      'prompt',
      'status',
      'task_id',
      'sessionId',
      'surface',
      'operation',
      'label',
    ],
  ],
  [['request_user_input'], ['questions', 'answers']],
  [['update_plan'], ['plan', 'todos', 'explanation']],
  [
    ['memory', 'remember', 'save_memory', 'update_memory', 'recall_memory', 'recall', 'search_memories'],
    [
      'action',
      'type',
      'operation',
      'op',
      'query',
      'queries',
      'text',
      'input',
      'summary',
      'element',
      'key',
      'name',
      'value',
      'limit',
      'topK',
    ],
  ],
  [
    ['code_graph'],
    ['mode', 'action', 'symbols', 'symbol', 'query', 'files', 'file', 'path', 'body', 'limit', 'depth', 'cwd'],
  ],
  [['cwd'], ['action', 'type', 'path', 'cwd', 'dir']],
  [['session'], ['action', 'title', 'path']],
  [['list_mcp_resources', 'list_mcp_resource_templates'], ['server']],
]);

export function toolActivityRepresentedKeys(normalizedName: string): Set<string> {
  return new Set(TOOL_REPRESENTED_KEYS[normalizedName] ?? []);
}
