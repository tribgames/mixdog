//! Pushed latest-wins state (DS §2.1, SPEC R14): one generic shape for every
//! section, carried as the params of the section's `<domain>/updated`
//! notification on the app feed or on the scoped feed named by its scope.

use serde::Deserialize;
use serde::Serialize;

use crate::JsonValue;

/// Where a section is delivered (SPEC R14).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum SectionFeed {
    /// App feed; part of the app attach snapshot.
    App,
    /// Scoped feed `git:<repoRoot>`.
    Git,
    /// Scoped feed `lsp:<root>`.
    Lsp,
    /// Scoped feed `media:<jobId>`.
    Media,
    /// Scoped feed `ports` (exists only while subscribed, SPEC §4.10).
    Ports,
    /// Scoped feed `connections` (exists only while subscribed).
    Connections,
}

impl SectionFeed {
    /// Whether the feed is of the ordered class (Lead decision 2026-11-11): its events are ones
    /// Node's phone path never drops, so a lane of it never lags once live.
    /// - `App`: settings, models, updater, notices, review, terminal activity and the browser /
    ///   visualize state are non-droppable pushes (`remote-relay-push-lanes.ts:119-168`), and
    ///   the session and agent rosters it carries are never droppable
    ///   (`remote-relay-catalog.ts:79-90`).
    /// - `Lsp`: `lspDiagnostics` / `lspStatus` (`remote-relay-push-lanes.ts:171-174`).
    /// - `Git`, `Media`, `Ports`, `Connections`: replace polls (re-reads after `folder-changed`, P9, P11), which
    ///   Node's phone path never pushed; merged latest-wins state.
    pub const fn ordered(self) -> bool {
        matches!(self, SectionFeed::App | SectionFeed::Lsp)
    }
}

macro_rules! sections {
    ($($(#[doc = $doc:literal])* $variant:ident => $wire:literal, $method:literal, $feed:ident, keyed: $keyed:literal;)*) => {
        /// Every section name. The registry is closed: adding one is a contract change.
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
        #[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
        pub enum SectionName {
            $($(#[doc = $doc])* #[serde(rename = $wire)] $variant,)*
        }

        impl SectionName {
            pub const ALL: &'static [SectionName] = &[$(SectionName::$variant,)*];

            pub const fn wire(self) -> &'static str {
                match self { $(SectionName::$variant => $wire,)* }
            }

            /// The notification method that carries this section.
            pub const fn notification_method(self) -> &'static str {
                match self { $(SectionName::$variant => $method,)* }
            }

            pub const fn feed(self) -> SectionFeed {
                match self { $(SectionName::$variant => SectionFeed::$feed,)* }
            }

            /// Whether values are per key (`key` non-null).
            pub const fn keyed(self) -> bool {
                match self { $(SectionName::$variant => $keyed,)* }
            }
        }
    };
}

sections! {
    /// `mixdog-config.json` subtrees (`desktop`, `notifications`, `toolPolicy`, `onboarding`, …); key = subtree.
    Config => "config", "config/updated", App, keyed: true;
    /// Registered projects.
    Projects => "projects", "project/updated", App, keyed: false;
    /// Agent pool rows.
    AgentPool => "agentPool", "agent/pool/updated", App, keyed: false;
    /// Agent list (today's `listAgents`).
    Agents => "agents", "agent/list/updated", App, keyed: false;
    /// Bot order (today's `getBotOrder`).
    BotOrder => "botOrder", "agent/botOrder/updated", App, keyed: false;
    /// Model presets (today's `listPresets`).
    Presets => "presets", "model/presets/updated", App, keyed: false;
    /// Model catalog (the `model/list` rows); when stubbed the client reads `model/list`, which is not paged.
    ModelCatalog => "modelCatalog", "model/catalog/updated", App, keyed: false;
    /// Workflow list (today's `listWorkflows`).
    Workflows => "workflows", "workflow/list/updated", App, keyed: false;
    /// Web-search route (today's `getWebSearchRoute`).
    WebSearch => "webSearch", "webSearch/updated", App, keyed: false;
    /// Tool-module settings, the value `getToolModuleSettings` answers today: `instructionFiles`,
    /// `autoEffortBase`, `webSearch`, `memory`, `git`, `office`, `tidy`, `visualize`, `media`,
    /// `localProvider` (with `installations`) and `autoEffort`. Pushed on change, replacing the
    /// desktop's status polls. Value: `ToolModuleSettings`.
    ToolModules => "toolModules", "toolModules/updated", App, keyed: false;
    /// Provider setup view (today's `getProviderSetup`, `listProviders`).
    ProviderSetup => "providerSetup", "account/updated", App, keyed: false;
    /// Provider accounts; key = provider id.
    ProviderAccounts => "providerAccounts", "account/updated", App, keyed: true;
    /// Usage summaries; key = scope.
    Usage => "usage", "usage/updated", App, keyed: true;
    /// Host-wide background shell totals.
    HostShellJobs => "hostShellJobs", "shellJobs/host/updated", App, keyed: false;
    /// Terminal activity per tab.
    TerminalActivity => "terminalActivity", "terminal/activity/updated", App, keyed: false;
    /// Terminal tab list.
    TerminalTabs => "terminalTabs", "terminal/tabs/updated", App, keyed: false;
    /// Remote access: `{info, settings, claims, clients, controllerKeys, owedKeys, pairCode, pushRegistered}`;
    /// `pairCode` is a `RemotePairCode`, or `null` while no live code is held; `pushRegistered` lists
    /// the ids of the paired clients holding a native push registration.
    Remote => "remote", "remote/state/updated", App, keyed: false;
    /// In-app notices; key = notice id.
    Notice => "notice", "notice/updated", App, keyed: true;
    /// Update status (core updater and the desktop's `host/update/report`).
    Update => "update", "update/status/updated", App, keyed: false;
    /// Desktop host state; key = `browserTabs` | `browserImport` | `visualize` | `displayPreferences` | `windowFocus` (desktop-published), or `remoteViewing` (core-published: the session ids paired devices show).
    HostState => "hostState", "host/state/updated", App, keyed: true;
    /// Computer use: `{active, observeOnly, controller, sessionThreadId}` (R40).
    Computer => "computer", "computer/updated", App, keyed: false;
    /// Pending approvals: count and per-thread summary.
    ApprovalInbox => "approvalInbox", "approval/inbox/updated", App, keyed: false;
    /// Core state, including `draining{reason}` (R21).
    Core => "core", "core/state/updated", App, keyed: false;
    /// Stall monitor report (`{stalledMs}`, R48).
    CoreHealth => "coreHealth", "core/health/updated", App, keyed: false;
    /// Migration progress.
    Migration => "migration", "migration/progress", App, keyed: false;
    /// The tell that open reviews may read differently (Node's global `turn-review-changed`): one app-wide revision per tell, no
    /// value; each window rereads the review of every session it shows.
    ReviewDiff => "reviewDiff", "review/diff/updated", App, keyed: false;
    /// Repository status; key = repo root (scoped feed `git:<root>`).
    GitStatus => "gitStatus", "git/status/updated", Git, keyed: true;
    /// Language-server status (scoped feed `lsp:<root>`); key = `<languageId>`, or
    /// `<languageId>\0<relPath>` for a status the server answered for one file (Node's
    /// `statusKey` in `editor-language-store.ts`). The value is Node's `DesktopLspStatusEvent`.
    LspStatus => "lspStatus", "lsp/status/updated", Lsp, keyed: true;
    /// Diagnostics (scoped feed `lsp:<root>`); key = document uri. The value is Node's
    /// `DesktopLspDiagnosticEvent`; an empty `diagnostics` list clears the document.
    LspDiagnostics => "lspDiagnostics", "lsp/diagnostics/updated", Lsp, keyed: true;
    /// Media job state; key = job id (scoped feed `media:<jobId>`).
    MediaJobs => "mediaJobs", "media/job/updated", Media, keyed: true;
    /// Listening ports (scoped feed `ports`).
    Ports => "ports", "system/ports/updated", Ports, keyed: false;
    /// Server connections (scoped feed `connections`, from `connections/subscribe`). Keys: `hosts` (the saved SSH servers),
    /// `restore` ({enabled, progress}), `link/<connectionId>` (ConnectionLinkView), `ports/<connectionId>` (ServerPortsView).
    Connections => "connections", "connections/updated", Connections, keyed: true;
}

/// Value above `INLINE_MAX` is replaced by a stub; the client pages the detail
/// with the section's list method.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct SectionStub {
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub count: u64,
    /// Always `true`.
    pub stub: bool,
}

/// Params of every section notification:
/// `{"section", "key", "revision", "value"}` or `{…, "removed": true}` or
/// `{…, "stub": {count, stub:true}}`. Exactly one of `value`, `removed`, `stub`.
/// The client keeps `(section,key)` iff `revision` is greater than the stored one.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
#[cfg_attr(feature = "codegen", ts(optional_fields))]
pub struct SectionUpdate {
    pub section: SectionName,
    pub key: Option<String>,
    /// Per `(section,key)`, strictly increasing.
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub revision: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub value: Option<JsonValue>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub removed: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stub: Option<SectionStub>,
}

/// A typed section published through `StatePublisher` (SPEC §3.2).
pub trait Section {
    const NAME: SectionName;
    type Value: Serialize;
}

/// The `pairCode` member of the `remote` section (today's `DesktopRemotePairCode`):
/// the relay code of an open Settings → Connection screen. `remoteAccess/pairCode`
/// issues or renews it; the section carries it, `null` once it expires or is released.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct RemotePairCode {
    /// Six digits, no separator.
    pub code: String,
    /// Epoch ms.
    #[cfg_attr(feature = "codegen", ts(type = "number"))]
    pub expires_at: i64,
}

/// One session's open execution in `computer`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ComputerSessionSection {
    pub session_thread_id: crate::ThreadId,
    pub observe_only: bool,
    /// Windows with an active command of this session (the overlay and the user-input report read them).
    #[serde(default)]
    pub window_ids: Vec<String>,
    /// How the active command reaches the screen; `null` while none runs.
    #[serde(default)]
    pub mode: Option<ComputerSessionMode>,
    /// The active command's phase word; `null` while none runs.
    #[serde(default)]
    pub phase: Option<String>,
}

/// Section value of `computer` (SPEC R40).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ComputerSection {
    pub active: bool,
    pub observe_only: bool,
    pub controller: Option<String>,
    /// Every session with an open execution, oldest first (the overlay draws one activity per session,
    /// `overlay/model.ts`); `active`, `observeOnly` and `sessionThreadId` describe the latest of them.
    pub sessions: Vec<ComputerSessionSection>,
    pub session_thread_id: Option<crate::ThreadId>,
    /// The user's hold on the desktop, which the pill offers to resume or stop; `null` while the user holds none.
    #[serde(default)]
    pub user_control: Option<ComputerUserControlSection>,
    /// The foreground lane every session's foreground input takes in turn; `null` while it is free.
    #[serde(default)]
    pub lane: Option<ComputerLaneSection>,
    #[serde(default)]
    pub backend: ComputerBackendSection,
    #[serde(default)]
    pub cleanup_state: ComputerCleanupState,
    /// Seconds of user idleness after which a hold ends by itself; 0 = only Resume ends it.
    #[serde(default = "default_idle_resume_seconds")]
    pub idle_resume_seconds: u32,
}

/// How a hold of the user's on the desktop ends (`host/user-input-refusal.ts` `resume_mode`): `idle` once the user has
/// been idle for the idle-resume interval, `manual` when they press Resume.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum ComputerResumeMode {
    Idle,
    Manual,
}

/// How a session's active command reaches the screen.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum ComputerSessionMode {
    Foreground,
    Background,
}

/// Which stack runs Computer Use: the Rust helper, or (Windows, until the owner signs off) the desktop's legacy host.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum ComputerBackendSection {
    #[default]
    Helper,
    DesktopHost,
}

/// Whether the end-of-run cleanup (held keys and buttons released) is done.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub enum ComputerCleanupState {
    #[default]
    Ready,
    Pending,
    Failed,
}

/// Node's coordinator default for the idle-resume interval.
fn default_idle_resume_seconds() -> u32 {
    5
}

/// The user's hold on the desktop in `computer` (Node's coordinator `userControlActive` and `takeoverReason`,
/// `session/coordinator.ts`): while it is active, automation waits.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ComputerUserControlSection {
    pub active: bool,
    /// Why the user holds the desktop (Node's `pauseForUser` reasons: `user_takeover`, `user_stop`, `user_input_active`,
    /// `input_cleanup_unconfirmed`, `authorization_changed`; `user_pause`, `desktop_unavailable` and `display_changed` from
    /// `computer/userControl` pause and takeover).
    pub reason: String,
    pub resume_mode: ComputerResumeMode,
}

/// The foreground lane in `computer` (Node's `host/command-queue-foreground.ts`): one keyboard and pointer, which the
/// sessions' foreground requests take one at a time.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "codegen", derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct ComputerLaneSection {
    /// Requests waiting behind the one in the lane.
    pub queued: u32,
    /// The phase of the request in the lane (Node's `ComputerUseActivityPhase`, such as `active_foreground`).
    pub phase: String,
}

impl Section for ComputerSection {
    const NAME: SectionName = SectionName::Computer;
    type Value = ComputerSection;
}
