// Where each recording is to be replayed in Rust, checked against the tree of o1 (6bf0a5bbf): `rust` lists public items that exist there
// (path:line, `pub` at that line, reachable through `pub mod` from the crate root); `protocolMethods` are methods of the public method
// table; `missing` lists the behaviour of the recording that has NO public Rust counterpart on o1: it is work for the Rust side (the
// recording is its contract), not a reason to skip the case.
const crates = 'native/core/crates/';
const r = (path, line, name, methods) => ({ path: `${crates}${path}`, line, name, ...(methods ? { methods } : {}) });
export const REPLAY_TARGETS = {
  'agent-home-cases': {
    rust: [r('mixdog-core-base/src/rooms/ids.rs', 27, 'agent_home_session_id'), r('mixdog-core-base/src/rooms/ids.rs', 33, 'agent_id_of_home_session'), r('mixdog-store/src/agent_mode.rs', 28, 'agent_id_of_home_session'), r('mixdog-core-agents/src/agents/home_agent.rs', 88, 'home_agent'), r('mixdog-core/src/run_host/prompt_session.rs', 197, 'workspace_prompt_context'), r('mixdog-core/src/run_host/prompt_session.rs', 264, 'compose_session_prompt', 'builds the role fields (role rules, lead mode rules, identity context, agent mode rules, mixy rules, skip role catalog / persona) through role_fields :217, private')],
    notPublic: ['the scratch decision (isScratchSession) exists: mixdog-core-session/src/session/thread_switches.rs:999 `is_scratch`, pub(crate): a replay reaches it through the thread switch, not by a call', 'home_agent.rs:52 `decide` is private (the role prompt decision is reached through home_agent)'],
    missing: [],
  },
  'agent-room-cases': {
    rust: [r('mixdog-core-rooms/src/rooms/config.rs', 157, 'parse_room_ask'), r('mixdog-core-rooms/src/rooms/config.rs', 206, 'room_mention_of'), r('mixdog-core-rooms/src/rooms/row_message.rs', 228, 'room_row_message'), r('mixdog-core-rooms/src/rooms/turn_prompt.rs', 296, 'room_turn_prompt'), r('mixdog-core-rooms/src/rooms/exchange.rs', 302, 'run_room_exchange'), r('mixdog-core-rooms/src/rooms/supervisor.rs', 115, 'supervisor_prompt'), r('mixdog-core-rooms/src/rooms/supervisor.rs', 100, 'supervisor_rows'), r('mixdog-core-rooms/src/rooms/supervisor.rs', 300, 'parse_room_decision'), r('mixdog-core-rooms/src/rooms/turn_post.rs', 137, 'post_speech'), r('mixdog-agent/src/one_shot.rs', 141, 'CallShape::room_supervisor', 'the supervisor completion call shape (room-supervisor-completion.mjs): no request kind, route effort or low, no 529 retry, no prompt cache; used by mixdog-core-rooms/src/rooms/maintainer.rs:56; `pub mod one_shot`, mixdog-agent/src/lib.rs:30'), r('mixdog-core/src/run_host/room_files.rs', 116, 'SessionFiles::take_in', 'impl RoomFiles for SessionFiles (room_files.rs:115; the trait is `pub trait RoomFiles` in mixdog-core-rooms/src/rooms/live.rs, `pub mod live`; `pub struct SessionFiles` :24, `pub mod room_files` run_host/mod.rs:156): the intake of a room speech row, its artifactsFrom taken in or rejected')],
    missing: [],
  },
  'capture-size-cases': {
    notPublic: ['provider preparation of an image part: mixdog-ai/src/providers/anthropic/lowering.rs:134 `part_to_block` (private; `mod lowering` is private, providers/anthropic/mod.rs:19) passes the base64 image bytes through (:137), which is what the second case records; mixdog-agent/src/compact/image.rs:71 `target_dimensions` is image compaction, a different contract'],
    missing: ['computerCaptureSize (fit to 1280 x 1568 and the 28 / 32 px patch budgets, error capture_geometry_invalid): not in the crates; owner of the new code: mixdog-ai (the capture frame is bound before provider preparation)', 'a public way to run the Anthropic message lowering on a message list with an image part (prepareAnthropicImages)'],
  },
  'compaction-archive-cases': {
    rust: [r('mixdog-store/src/compaction_view.rs', 203, 'archive_items_for_compaction')],
    notPublic: ['serialize_archive / ensure_archive (mixdog-agent compact/execution_tail.rs:160, :317) are private', 'message-id stamping of reference files: mixdog-agent/src/compact/messages.rs:124 inside the private `reference_files_manifest` (:93)'],
    missing: ['the segment writer, the .compaction-archive.pending sidecar, the delete fences and the startup scan: no counterpart found'],
  },
  'data-dir-retarget-cases': {
    missing: ['no public counterpart: settings.rs:98 `with_data_dir` sets the bot store directory of the onboarding summary, not the data dir the config follows', 'readSection / updateSection under a data dir changed after start: config/mod.rs:629 `update` is the nearest and its data-dir following is not shown', 'the turn snapshot store root: no public function that takes the data dir'],
  },
  'desktop-visibility-restart-cases': {
    protocolMethods: ['thread/resume (setVisibleSessions, mixdog-app-protocol/src/inventory.rs:1125)'],
    missing: ['the desktop service registry (init / versioned setVisibleSessions / releaseClient / unsubscribe and its frames): no Rust counterpart found'],
  },
  'error-presentation-cases': {
    rust: [r('mixdog-ai/src/service/error_text.rs', 174, 'present_error_text'), r('mixdog-ai/src/service/error_text.rs', 346, 'safe_error_details'), r('mixdog-ai/src/retry/classify.rs', 142, 'kind_of', 'classifies Facts (status, code, scope) into an ErrorKind; `pub mod retry`, `pub mod classify`; the nearest to providerErrorKind, whose input is an error object')],
    notPublic: ['describeError: mixdog-ai/src/service/error_text.rs:694 `describe_error` is private', 'anthropicQuotaError: mixdog-ai/src/providers/anthropic/errors.rs:103 `quota_error_text` is pub(super)'],
    missing: ['providerErrorKind over an error object and the DETERMINISTIC_KINDS list: kind_of takes Facts, no constant list of deterministic kinds'],
  },
  'first-response-budgets': {
    rust: [r('mixdog-ai/src/providers/first_byte.rs', 58, 'FirstByteSettings::from_env'), r('mixdog-ai/src/providers/first_byte.rs', 109, 'FirstByteSettings::antigravity_budget')],
    missing: [],
  },
  'local-send-queue': {
    rust: [r('mixdog-ai/src/providers/local/mod.rs', 150, 'RegisteredAdapter::new'), r('mixdog-services/src/local_provider/installed_models.rs', 40, 'ManagedRuntime')],
    missing: [],
  },
  'git-launch-cases': {
    rust: [r('mixdog-scm/src/git_launch.rs', 119, 'resolve_layout'), r('mixdog-scm/src/git_launch.rs', 207, 'launch_environment'), r('mixdog-scm/src/git_launch.rs', 267, 'launch_for'), r('mixdog-scm/src/git_launch.rs', 287, 'git_command'), r('mixdog-scm/src/git_launch.rs', 295, 'forget_missing'), r('mixdog-scm/src/git.rs', 90, 'start_git')],
    missing: ['startGitSync (the synchronous start with the same retry): no function'],
  },
  'github-cases': {
    rust: [r('mixdog-scm/src/gh/client.rs', 61, 'GhRunner'), r('mixdog-scm/src/gh/client.rs', 259, 'new'), r('mixdog-scm/src/gh/client.rs', 281, 'run_args'), r('mixdog-scm/src/gh/client.rs', 294, 'execute'), r('mixdog-tools/src/github/mod.rs', 45, 'github_call_mutates')],
    protocolMethods: ['github/request (mixdog-scm/src/service.rs:573, served through `impl DomainService for ScmHandle` :598, `pub struct ScmHandle` :595, `pub mod service`)'],
    notPublic: ['mixdog-scm/src/service.rs:452 `github_request` (the handler behind github/request) is private; the method table is its public door'],
  },
  'hook-ask-grants-cases': {
    rust: [r('mixdog-tools/src/policy/gate.rs', 237, 'decide'), r('mixdog-tools/src/policy/session_grants.rs', 49, 'grant'), r('mixdog-tools/src/policy/session_grants.rs', 68, 'has'), r('mixdog-tools/src/policy/grants.rs', 158, 'set_mode'), r('mixdog-tools/src/policy/grants.rs', 321, 'GrantStore'), r('mixdog-tools/src/policy/grants.rs', 362, 'GrantStore::audit', 'reads the audit entries'), r('mixdog-tools/src/policy/card.rs', 59, 'build')],
    protocolMethods: ['agent/setAgentPermission (setAgentPermission: mixdog-app-protocol/src/methods.rs:1025 AgentSetAgentPermission, inventory.rs:3162-3163; the handler is the match arm mixdog-core-agents/src/setup/agent_settings.rs:264, private)'],
    notPublic: ['recordHumanDecision: the audit writes are private: mixdog-tools/src/policy/pipeline.rs:587 `audit`, mixdog-core/src/run_host/handoff_env.rs:92 `record_decision`, mixdog-app-server-daemon/src/held_requests.rs:305 `record_decision`'],
    missing: [],
  },
  'session-grants-cases': {
    rust: [r('mixdog-tools/src/policy/gate.rs', 237, 'decide'), r('mixdog-tools/src/policy/session_grants.rs', 49, 'grant'), r('mixdog-tools/src/policy/session_grants.rs', 68, 'has'), r('mixdog-tools/src/policy/grants.rs', 158, 'set_mode'), r('mixdog-tools/src/policy/grants.rs', 321, 'GrantStore'), r('mixdog-tools/src/policy/grants.rs', 362, 'GrantStore::audit', 'reads the audit entries')],
    notPublic: ['recordHumanDecision: the audit writes are private: mixdog-tools/src/policy/pipeline.rs:587 `audit`, mixdog-core/src/run_host/handoff_env.rs:92 `record_decision`, mixdog-app-server-daemon/src/held_requests.rs:305 `record_decision`'],
    missing: [],
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
    rust: [r('mixdog-core/src/run_host/heartbeat_parts.rs', 262, 'production_heartbeat'), r('mixdog-core-agents/src/agents/mod.rs', 209, 'AgentDefinitions', 'lead_status (agents/mod.rs:701), set_lead_created (agents/lead.rs:134), mixy_exists (agents/mod.rs:715)'), r('mixdog-services/src/bots/delivery/home.rs', 589, 'drain'), r('mixdog-services/src/bots/delivery/queue.rs', 536, 'pending_homes')],
    notPublic: ['routineOwnerProblem: mixdog-core/src/run_host/routine_host.rs:114 `owner_problem` is private', 'mixy_exists in mixdog-core/src/run_host/home_directory.rs:50 and heartbeat_parts.rs:53 are private (the public one is agents/mod.rs:715)'],
  },
  'model-proxy-host-cases': {
    rust: [r('mixdog-ai/src/service/model_proxy.rs', 76, 'without_attachment_references'), r('mixdog-core/src/run_host/model_proxy_pc.rs', 80, 'PcQuotaProbe'), r('mixdog-core/src/run_host/model_proxy_pc.rs', 250, 'PcProviderConfig')],
    missing: [],
  },
  'model-proxy-host-trust-cases': {
    rust: [r('mixdog-ai/src/service/model_proxy.rs', 76, 'without_attachment_references'), r('mixdog-core-domains/src/domains/ai_admin/model_proxy_service.rs', 184, 'ModelProxyService::call', 'the `modelProxy/run` request: admission by payload size, then the run and its typed events')],
    missing: [],
  },
  'project-recency-failure-cases': {
    rust: [r('mixdog-store/src/registry.rs', 282, 'add'), r('mixdog-store/src/registry.rs', 309, 'touch_selected'), r('mixdog-store/src/registry.rs', 335, 'remove'), r('mixdog-store/src/registry.rs', 354, 'rename')],
    protocolMethods: ['startProjectTask (mixdog-app-protocol/src/inventory.rs:888, :1222)'],
    notPublic: ['a recency write failure that does not stop the work exists for set_cwd: mixdog-core-session/src/session/thread_settings.rs:754 logs the touch_selected failure and continues (private trait-impl method :714; trait ProjectFolders :100 / touch_selected :110 is public)'],
    missing: ['startProjectTask / submitNewTask continuing when only the recency write fails: new_task.rs:531, :573 hold no recency code'],
  },
  'provider-accounts-policy-cases': {
    rust: [r('mixdog-ai/src/accounts/policy.rs', 337, 'choose_account'), r('mixdog-ai/src/accounts/policy.rs', 270, 'account_limit'), r('mixdog-ai/src/accounts/policy.rs', 308, 'account_exhausted_for_model_only'), r('mixdog-ai/src/accounts/mod.rs', 299, 'AccountStore::pool'), r('mixdog-ai/src/accounts/mod.rs', 368, 'AccountStore::register'), r('mixdog-ai/src/accounts/mod.rs', 405, 'AccountStore::change'), r('mixdog-ai/src/accounts/mod.rs', 503, 'AccountStore::record_usage')],
    missing: [],
  },
  'room-user-send-cases': {
    protocolMethods: ['room/send (mixdog-app-protocol/src/methods.rs RoomSend; served by mixdog-core-rooms/src/rooms/service.rs RoomService, whose send step is rooms/user_send.rs UserSend over live.rs LiveRooms::send)'],
  },
  'quiet-progress-cases': {
    rust: [r('mixdog-core-agents/src/agents/pool_list.rs', 139, 'AgentPool', 'list (pool_list.rs:624) returns the pool rows decorated with progressAt, progressStage (model_thinking while a sent request awaits its headers), progressTool and stallWarnMs from the private with_progress (:785); re-exported by agents/mod.rs:50'), r('mixdog-agent/src/agent_tool/watchdog.rs', 123, 'stall_warn_ms')],
    missing: ['the quiet cue and its labels (quietProgress / quietProgressParts / quietWaitKind, "quiet for 3m · running shell", the cue window and the freeze until the warn point): no Rust code; agent_tool/progress.rs:300 builds a different text ("tool possibly hung", task progress)'],
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
    missing: ['the desktop wire (IPC envelope, preload, Korean text): no Rust counterpart (the codes exist; the page text and the envelope the desktop builds from them do not)'],
  },
  'session-host-cold-refresh-cases': {
    missing: ['the desktop SessionHost cold-view refresh (ticks, concurrency, session-state updates): no production counterpart found'],
  },
  'session-host-lifecycle-cases': {
    rust: [r('mixdog-app-server-daemon/src/compose_flip.rs', 214, 'start_sub_agent_retention'), r('mixdog-app-server-daemon/src/compose_flip.rs', 223, 'sub_agent_retention_step'), r('mixdog-core-session/src/session/worktree_maintenance.rs', 169, 'set_archived_session_worktrees'), r('mixdog-core-session/src/session/agent_registry/mod.rs', 557, 'forget_deleted_session'), r('mixdog-core-session/src/session/thread_settings.rs', 341, 'mark_read')],
    missing: ['the restore of archived session trees and the desktop host disposal (overlapping disposals share one attachment cleanup): no counterpart found'],
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
    protocolMethods: ['thread/fork (mixdog-app-server/src/server.rs:114; mixdog-app-protocol/src/inventory.rs:1139-1141 inheritSession): handle.rs:476 `fork` calls carry_into at handle.rs:492'],
    notPublic: ['mixdog-core-session/src/session/inheritance.rs:100 `carry_into` is pub(super): it is reached through thread/fork'],
  },
  'session-lane-backlog-cases': {
    missing: ['the session frame stream (attachSse, broadcast, drain, maxPendingBytes): no counterpart found'],
  },
  'session-reentry-cases': {
    notPublic: ['idle eviction: mixdog-core-session/src/session/actor.rs:1233 `arm_idle_evict` / :1240 `on_idle_evict` (private) re-arm the deadline and check has_active("agent" / "shell") (:1248); that is the only part of the recording they show'],
    missing: ['the unload of an idle session and its re-entry from the stored view, the replayed submission id join and the read tracing diagnostics: no counterpart found'],
  },
  'shell-job-stop-lifecycle-cases': {
    rust: [r('mixdog-core-session/src/session/shell_jobs.rs', 63, 'ShellJobsService')],
    protocolMethods: ['thread/backgroundTerminals/terminate (stopShellJob, mixdog-core-session/src/session/shell_jobs.rs:TERMINATE)', 'thread/listShellJobs', 'thread/shellJobs/updated (mixdog-core-session/src/session/actor.rs:2053; the ShellJobs section, mixdog-core-session/src/session/exec_events.rs:79)'],
    notPublic: ['idle reclaim around a running shell job: actor.rs:162 IDLE_EVICT, :1233 arm_idle_evict, :1248 has_active("shell") (private)'],
    missing: ['the desktop SessionHost pane (the rows it publishes from the job watcher timers, the show / hide reload): no counterpart found'],
  },
  'slash-commands-cases': {
    missing: ['slash tokens: mixdog-core-session/src/session/pending.rs:118 `recognised_slash_token` is pub(crate), SLASH_TOKENS is private; the argument hint has no counterpart', 'the /btw panel scroll and row functions (src/tui/app/btw-controller.mjs, slash-commands.mjs overlayBlocksGlobalTranscriptScroll): Node TUI code, no Rust TUI'],
  },
  'store-agent-worker-pool-cases': {
    rust: [r('mixdog-core-agents/src/agents/pool_list.rs', 139, 'AgentPool', 'new (pool_list.rs:619), list (pool_list.rs:624); re-exported by agents/mod.rs:50')],
    missing: ['the persisted header cache, the link list and the stat / read counters: no counterpart found'],
  },
  'store-summary-visibility-cases': {
    rust: [r('mixdog-store/src/summary.rs', 78, 'is_root_lead_session'), r('mixdog-store/src/summary.rs', 88, 'session_visibility'), r('mixdog-store/src/sqlite/lead.rs', 65, 'is_lead_visible_row'), r('mixdog-store/src/sqlite/lead.rs', 120, 'lead_page_of')],
  },
  'store-summary-workspace-cases': {
    rust: [r('mixdog-store/src/summary.rs', 107, 'workspace_summary')],
  },
  'cursor-client-version-cases': {
    rust: [r('mixdog-ai/src/client_versions.rs', 511, 'ClientVersions', 'warm (client_versions.rs:608), cursor (client_versions.rs:592)')],
  },
  'file-has-data-cases': {
    rust: [r('mixdog-services/src/local_provider/catalog.rs', 29, 'file_has_data'), r('mixdog-services/src/local_provider/catalog.rs', 42, 'exact_file')],
  },
  'skill-creator-validator-cases': {
    rust: [r('mixdog-mcp/src/skills.rs', 218, 'collect_skills')],
  },
  'computer-error-recovery': {
    rust: [r('mixdog-tools/src/desktop/computer_recovery.rs', 139, 'tool_error_recovery'), r('mixdog-tools/src/desktop/computer_recovery.rs', 144, 'format_tool_error'), r('mixdog-tools/src/desktop/computer.rs', 59, 'ComputerTool', 'the call: a failure of the host is worded by format_tool_error')],
    missing: ['computerResultRecovery (a reply body with a structured code): the Rust backend answers its replies as text parts'],
  },
  'google-mcp': {
    rust: [r('mixdog-mcp/src/google_mcp.rs', 639, 'answer'), r('mixdog-mcp/src/google_mcp.rs', 83, 'service'), r('mixdog-mcp/src/http.rs', 93, 'HttpTransport::with_google_fetch')],
    notPublic: ['the sign-in flow (PKCE, loopback redirect) is replayed by the mcp-oauth sets; here the connector end is'],
  },
  'session-tool-output': {
    rust: [r('mixdog-core/src/run_host/tool_pool/session_output.rs', 101, 'session_list_output'), r('mixdog-core/src/run_host/tool_pool/session_output.rs', 254, 'session_read_output'), r('mixdog-core/src/run_host/tool_pool/session_port.rs', 217, 'DirectorySessionPort::read', 'action read of control')],
    missing: ['session action=list, send, create and bots are not served by the session port (control answers "not available in this runtime" for them): the list shape is replayed through session_list_output only'],
  },
  'session-control-cases': {
    rust: [r('mixdog-core/src/run_host/tool_pool/session_port.rs', 1, 'DirectorySessionPort::control')],
  },
  'session-compact-cases': {
    rust: [r('mixdog-tools/src/orch/session.rs', 204, 'SessionTool', 'the session tool: actions compact and fork'), r('mixdog-core/src/run_host/tool_pool/session_port.rs', 377, 'DirectorySessionPort::schedule_compact'), r('mixdog-core/src/run_host/tool_pool/session_port.rs', 381, 'DirectorySessionPort::fork'), r('mixdog-core-session/src/session/directory.rs', 459, 'SessionDirectory::schedule_compact_after_turn', 'the actor runs the scheduled compaction when the thread\'s turn settles')],
    notPublic: ['the settle itself (mixdog-core-session/src/session/actor.rs run_ended) is private: a replay reaches it by running a turn on a SessionDirectory'],
  },
  'system-proxy-cases': {
    rust: [r('mixdog-app-server-daemon/src/system_proxy_claim.rs', 28, 'new'), r('mixdog-ai/src/netproxy/system.rs', 601, 'attach_resolver'), r('mixdog-ai/src/netproxy/system.rs', 354, 'route_from_chromium')],
    missing: ['the desktop answer envelopes of attach and release (the lease the desktop holds and its release answer): system_proxy_claim.rs and netproxy/system.rs hold the resolver attach and the Chromium route only; no release answer function in either'],
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
  return { ...own, rustTargets: t.rust ?? [], protocolMethods: t.protocolMethods ?? [], existsButNotPublicOnO1: t.notPublic ?? [], missingOnO1: t.missing ?? [], targetsCheckedAgainst: 'o1 6bf0a5bbf: each rust target exists at path:line, is declared `pub` and is reachable through `pub mod` or `pub use` from its crate root', ...rest };
}
