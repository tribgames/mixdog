// Where each recording is to be replayed in Rust, checked against the tree of o1 (6bf0a5bbf): `rust` lists public items that exist there
// (path:line, `pub` at that line, reachable through `pub mod` from the crate root); `protocolMethods` are methods of the public method
// table; `missing` lists the behaviour of the recording that has NO public Rust counterpart on o1: it is work for the Rust side (the
// recording is its contract), not a reason to skip the case.
const crates = 'native/core/crates/';
const r = (path, line, name, methods) => ({ path: `${crates}${path}`, line, name, ...(methods ? { methods } : {}) });
export const REPLAY_TARGETS = {
  'agent-home-cases': {
    rust: [r('mixdog-core-base/src/rooms/ids.rs', 27, 'agent_home_session_id'), r('mixdog-core-base/src/rooms/ids.rs', 33, 'agent_id_of_home_session'), r('mixdog-core-agents/src/agents/home_agent.rs', 88, 'home_agent')],
    missing: ['isAgentHomeSessionId: no function of that meaning', 'the role prompt fields and the scratch decision: home_agent.rs:52 `decide` is private'],
  },
  'agent-room-cases': {
    rust: [r('mixdog-core-rooms/src/rooms/config.rs', 157, 'parse_room_ask'), r('mixdog-core-rooms/src/rooms/config.rs', 206, 'room_mention_of'), r('mixdog-core-rooms/src/rooms/row_message.rs', 228, 'room_row_message'), r('mixdog-core-rooms/src/rooms/turn_prompt.rs', 296, 'room_turn_prompt'), r('mixdog-core-rooms/src/rooms/exchange.rs', 302, 'run_room_exchange'), r('mixdog-core-rooms/src/rooms/supervisor.rs', 115, 'supervisor_prompt'), r('mixdog-core-rooms/src/rooms/supervisor.rs', 100, 'supervisor_rows'), r('mixdog-core-rooms/src/rooms/supervisor.rs', 300, 'parse_room_decision'), r('mixdog-core-rooms/src/rooms/turn_post.rs', 137, 'post_speech')],
    missing: ['the supervisor completion request (room-supervisor-completion.mjs): maintainer.rs only cites it in a doc comment', 'the log intake (agent-room-delivery.mjs): no public function; post_speech is the nearest and is a different step'],
  },
  'capture-size-cases': {
    rust: [r('mixdog-agent/src/compact/image.rs', 71, 'target_dimensions')],
    missing: ['computerCaptureSize (fit to 1280 x 1568 and the 28 / 32 px patch budgets, error capture_geometry_invalid): not in the crates', 'preparation of an already bound computer frame without rescale: target_dimensions is the Anthropic image box of compaction, a different contract'],
  },
  'compaction-archive-cases': {
    rust: [r('mixdog-store/src/compaction_view.rs', 203, 'archive_items_for_compaction')],
    missing: ['serialize_archive / ensure_archive (mixdog-agent compact/execution_tail.rs:160, :317) are private', 'the segment writer, the .compaction-archive.pending sidecar, message-id stamping, the delete fences and the startup scan: no counterpart found'],
  },
  'data-dir-retarget-cases': {
    missing: ['no public counterpart: settings.rs:98 `with_data_dir` sets the bot store directory of the onboarding summary, not the data dir the config follows', 'readSection / updateSection under a data dir changed after start: config/mod.rs:629 `update` is the nearest and its data-dir following is not shown', 'the turn snapshot store root: no public function that takes the data dir'],
  },
  'desktop-visibility-restart-cases': {
    protocolMethods: ['thread/resume (setVisibleSessions, mixdog-app-protocol/src/inventory.rs:1125)'],
    missing: ['the desktop service registry (init / versioned setVisibleSessions / releaseClient / unsubscribe and its frames): no Rust counterpart found'],
  },
  'error-presentation-cases': {
    rust: [r('mixdog-ai/src/service/error_text.rs', 174, 'present_error_text'), r('mixdog-ai/src/service/error_text.rs', 346, 'safe_error_details')],
    missing: ['describeError: error_text.rs:694 `describe_error` is private', 'providerErrorKind / DETERMINISTIC_KINDS and anthropicQuotaError: no function (doc references only)'],
  },
  'git-launch-cases': {
    rust: [r('mixdog-scm/src/git_launch.rs', 119, 'resolve_layout'), r('mixdog-scm/src/git_launch.rs', 207, 'launch_environment'), r('mixdog-scm/src/git_launch.rs', 287, 'git_command'), r('mixdog-scm/src/git.rs', 90, 'start_git')],
    missing: ['resolveGitLaunch under that name, gitChildEnv and startGitSync: no function'],
  },
  'github-cases': {
    rust: [r('mixdog-scm/src/gh/client.rs', 61, 'GhRunner'), r('mixdog-scm/src/gh/client.rs', 259, 'new'), r('mixdog-scm/src/gh/client.rs', 281, 'run_args'), r('mixdog-scm/src/gh/client.rs', 294, 'execute'), r('mixdog-tools/src/github/mod.rs', 45, 'github_call_mutates')],
    missing: ['the github tool request handler is private (mixdog-scm/src/service.rs:452 `github_request`)'],
  },
  'hook-ask-grants-cases': {
    rust: [r('mixdog-tools/src/policy/gate.rs', 237, 'decide'), r('mixdog-tools/src/policy/session_grants.rs', 49, 'grant'), r('mixdog-tools/src/policy/session_grants.rs', 68, 'has'), r('mixdog-tools/src/policy/grants.rs', 158, 'set_mode'), r('mixdog-tools/src/policy/grants.rs', 321, 'GrantStore'), r('mixdog-tools/src/policy/card.rs', 59, 'build')],
    missing: ['recordHumanDecision: no public function (the audit write is private, policy/pipeline.rs:587)', 'setAgentPermission: only a match arm in mixdog-core-agents/src/setup/agent_settings.rs:264'],
  },
  'session-grants-cases': {
    rust: [r('mixdog-tools/src/policy/gate.rs', 237, 'decide'), r('mixdog-tools/src/policy/session_grants.rs', 49, 'grant'), r('mixdog-tools/src/policy/session_grants.rs', 68, 'has'), r('mixdog-tools/src/policy/grants.rs', 158, 'set_mode'), r('mixdog-tools/src/policy/grants.rs', 321, 'GrantStore')],
    missing: ['recordHumanDecision: no public function (the audit write is private, policy/pipeline.rs:587)'],
  },
  'media-store-cases': {
    rust: [r('mixdog-services/src/media/store.rs', 317, 'list_assets'), r('mixdog-services/src/media/store.rs', 436, 'delete_assets'), r('mixdog-services/src/media/store.rs', 472, 'list_boards'), r('mixdog-services/src/media/store.rs', 498, 'create_board'), r('mixdog-services/src/media/store.rs', 523, 'delete_board')],
    protocolMethods: ['media/listMediaAssets', 'media/deleteMediaAssets', 'media/listMediaBoards', 'media/createMediaBoard'],
  },
  'mcp-oauth-control-session-cases': {
    protocolMethods: ['mixdog-app-protocol/src/methods.rs: McpBeginMcpOAuthLogin (:2204), McpGetMcpOAuthLoginStatus (:2141), McpCompleteMcpOAuthLogin (:2222), McpSignOutMcpServer (:2231)'],
    missing: ['the replacement of the control session between the calls: no Rust counterpart of the desktop control session was found'],
  },
  'mixy-presence-cases': {
    rust: [r('mixdog-core/src/run_host/heartbeat_parts.rs', 262, 'production_heartbeat'), r('mixdog-core-agents/src/agents/mod.rs', 209, 'AgentDefinitions', 'lead_status (agents/mod.rs:701), set_lead_created (agents/lead.rs:134)')],
    missing: ['routineOwnerProblem (routine_host.rs:114 `owner_problem`) and mixy_exists (home_directory.rs:50, heartbeat_parts.rs:53) are private', 'the home delivery drain and the routine result queue: no public counterpart found'],
  },
  'model-proxy-host-cases': {
    rust: [r('mixdog-ai/src/service/model_proxy.rs', 76, 'without_attachment_references')],
    missing: ['the PC host (createModelProxyHost: claim, heartbeat and lease, abort, providerConfig reads, quotaUsable): mixdog-core/src/run_host/model_proxy_pc.rs holds PcProviderConfig only'],
  },
  'model-proxy-host-trust-cases': {
    rust: [r('mixdog-ai/src/service/model_proxy.rs', 76, 'without_attachment_references')],
    missing: ['the PC host (claims bounded by maxSnapshotEntries, in-flight byte limits, projected callbacks): no counterpart found'],
  },
  'project-recency-failure-cases': {
    rust: [r('mixdog-store/src/registry.rs', 282, 'add'), r('mixdog-store/src/registry.rs', 309, 'touch_selected'), r('mixdog-store/src/registry.rs', 335, 'remove'), r('mixdog-store/src/registry.rs', 354, 'rename')],
    missing: ['the SessionHost behaviour (startProjectTask / submitNewTask that continue when only the recency write fails): no Rust counterpart found'],
  },
  'provider-accounts-policy-cases': {
    rust: [r('mixdog-ai/src/accounts/policy.rs', 337, 'choose_account'), r('mixdog-ai/src/accounts/policy.rs', 270, 'account_limit'), r('mixdog-ai/src/accounts/policy.rs', 308, 'account_exhausted_for_model_only')],
    missing: ['the roster file reader and writer (registerProviderAccount, changeProviderAccounts, readProviderAccountPool; policy / auto mapping): no counterpart found'],
  },
  'quiet-progress-cases': {
    missing: ['the whole recording: no Rust code produces the quiet cue, its labels or the pool-row decoration (see replay.entry)'],
  },
  'remote-idle-state-cases': {
    rust: [r('mixdog-core-goal/src/goal/state.rs', 315, 'active_elapsed_ms'), r('mixdog-core-goal/src/goal/state.rs', 330, 'public_goal'), r('mixdog-core-goal/src/goal/state.rs', 361, 'goal_state_snapshot')],
    missing: ['the snapshot delta encoder / decoder (compact and plain wire, isNoDelta, markCompactWire) and the pulse delivery: no counterpart found'],
  },
  'remote-streaming-mailbox-cases': {
    missing: ['the remote streaming mailbox, REMOTE_STREAM_BATCH_MS and streamingPartialSuffix: no counterpart found in the app-server, daemon, core-api, core-base or remote crates'],
  },
  'remote-transcript-window-cases': {
    protocolMethods: ['thread/items/list (mixdog-app-protocol/src/methods.rs:185)'],
    missing: ['the phone transcript window (encodePhoneSessionState, requestPhoneTranscriptPage, remoteToolOutput): no counterpart found'],
  },
  'schedule-error-wire-cases': {
    rust: [r('mixdog-services/src/scheduler/model.rs', 129, 'SCHEDULE_NAME_TAKEN'), r('mixdog-services/src/scheduler/model.rs', 130, 'SCHEDULE_RENAME_RUNNING'), r('mixdog-services/src/scheduler/model.rs', 131, 'SCHEDULE_RENAME_RELOAD_FAILED'), r('mixdog-services/src/scheduler/model.rs', 132, 'SCHEDULE_RENAME_UNCERTAIN')],
    missing: ['the desktop wire (IPC envelope, preload, Korean text): no Rust counterpart'],
  },
  'session-host-cold-refresh-cases': {
    missing: ['the desktop SessionHost cold-view refresh (ticks, concurrency, session-state updates): no production counterpart found'],
  },
  'session-host-lifecycle-cases': {
    rust: [r('mixdog-app-server-daemon/src/compose_flip.rs', 214, 'start_sub_agent_retention'), r('mixdog-app-server-daemon/src/compose_flip.rs', 223, 'sub_agent_retention_step')],
    missing: ['the sidebar archive / restore of session trees, forgetSessionMetadata, markSessionRead and host disposal: no counterpart found'],
  },
  'session-host-transcript-page-cases': {
    protocolMethods: ['thread/items/list (mixdog-app-protocol/src/methods.rs:185)'],
    missing: ['the page / full reply shape, projectionStamp and transcriptHeld: no counterpart found'],
  },
  'session-host-transport-read-set-cases': {
    protocolMethods: ['mixdog-app-protocol/src/inventory.rs:1115-1145: prefetchSession -> thread/read, readTranscriptHistory -> thread/items/list, setVisibleSessions -> thread/resume, submitToSession -> turn/start'],
    missing: ['the lane each action is sent on: not shown in the method table'],
  },
  'session-inheritance-cases': {
    protocolMethods: ['thread/fork (mixdog-app-server/src/server.rs:114)'],
    missing: ['carry_into (mixdog-core-session/src/session/inheritance.rs:95) is pub(super): not callable from outside; the transcript restore has no counterpart found'],
  },
  'session-lane-backlog-cases': {
    missing: ['the session frame stream (attachSse, broadcast, drain, maxPendingBytes): no counterpart found'],
  },
  'session-reentry-cases': {
    missing: ['idle eviction is private (mixdog-core-session/src/session/actor.rs:1233 `arm_idle_evict`); the host re-entry, replayed submission id join and read tracing diagnostics have no counterpart found'],
  },
  'shell-job-stop-lifecycle-cases': {
    rust: [r('mixdog-core-session/src/session/shell_jobs.rs', 63, 'ShellJobsService')],
    protocolMethods: ['thread/backgroundTerminals/terminate (stopShellJob, mixdog-core-session/src/session/shell_jobs.rs:TERMINATE)', 'thread/listShellJobs'],
    missing: ['the desktop SessionHost pane publication (session-state shellJobs rows) and the session service idle reclaim around it: no counterpart found (idle eviction is private, mixdog-core-session/src/session/actor.rs:1233)'],
  },
  'slash-commands-cases': {
    missing: ['slash tokens: mixdog-core-session/src/session/pending.rs:118 `recognised_slash_token` is pub(crate), SLASH_TOKENS is private; the argument hint has no counterpart', 'the /btw panel scroll and row functions (src/tui/app/btw-controller.mjs, slash-commands.mjs overlayBlocksGlobalTranscriptScroll): Node TUI code, no Rust TUI'],
  },
  'store-agent-worker-pool-cases': {
    rust: [r('mixdog-core-agents/src/agents/pool_list.rs', 139, 'AgentPool', 'new (pool_list.rs:619), list (pool_list.rs:624)')],
    missing: ['the persisted header cache, the link list and the stat / read counters: no counterpart found'],
  },
  'store-summary-visibility-cases': {
    rust: [r('mixdog-store/src/summary.rs', 78, 'is_root_lead_session'), r('mixdog-store/src/summary.rs', 88, 'session_visibility'), r('mixdog-store/src/sqlite/lead.rs', 65, 'is_lead_visible_row'), r('mixdog-store/src/sqlite/lead.rs', 120, 'lead_page_of')],
  },
  'store-summary-workspace-cases': {
    rust: [r('mixdog-store/src/summary.rs', 107, 'workspace_summary')],
  },
  'system-proxy-cases': {
    rust: [r('mixdog-app-server-daemon/src/system_proxy_claim.rs', 28, 'new'), r('mixdog-ai/src/netproxy/system.rs', 601, 'attach_resolver'), r('mixdog-ai/src/netproxy/system.rs', 354, 'route_from_chromium')],
  },
};
/** The manifest's `replay` for a set: `entry` names only public Rust items that exist on o1 (listed in `rustTargets`, checked), the recorder's
 *  own description of what to compare is kept as `compare`; whatever has no public counterpart is listed in `missingOnO1` (Rust-side work). */
export function replayFor(setName, original) {
  const t = REPLAY_TARGETS[setName];
  if (!t) throw new Error(`no replay targets for ${setName}`);
  const named = [...(t.rust ?? []).map((e) => `${e.path.replace(crates, '')}:${e.line} ${e.name}${e.methods ? ` (${e.methods})` : ''}`), ...(t.protocolMethods ?? [])];
  const { entry, ...rest } = original;
  const own = String(entry).startsWith('NO RUST ENTRY') ? { entry } : {
    entry: named.length ? `Drive these public items on o1: ${named.join('; ')}.` : `NO RUST ENTRY ON o1: ${(t.missing ?? []).join('; ')}.`,
    compare: entry,
  };
  return { ...own, rustTargets: t.rust ?? [], protocolMethods: t.protocolMethods ?? [], missingOnO1: t.missing ?? [], targetsCheckedAgainst: 'o1 6bf0a5bbf: each rust target exists at path:line, is declared `pub` and is reachable through `pub mod` or `pub use` from its crate root', ...rest };
}
