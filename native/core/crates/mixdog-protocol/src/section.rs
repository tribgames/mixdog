//! Pushed latest-wins state (DS §2.1, SPEC R14): one generic shape for every
//! section, carried as the params of the section's `<domain>/updated`
//! notification on the app feed or on the scoped feed named by its scope.

use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use ts_rs::TS;

use crate::JsonValue;

/// Where a section is delivered (SPEC R14).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub enum SectionFeed {
    /// App feed; part of the app attach snapshot.
    App,
    /// The thread feed of the key (`reviewDiff`).
    Thread,
    /// Scoped feed `git:<repoRoot>`.
    Git,
    /// Scoped feed `lsp:<root>`.
    Lsp,
    /// Scoped feed `media:<jobId>`.
    Media,
    /// Scoped feed `ports` (exists only while subscribed, SPEC §4.10).
    Ports,
}

macro_rules! sections {
    ($($(#[doc = $doc:literal])* $variant:ident => $wire:literal, $method:literal, $feed:ident, keyed: $keyed:literal;)*) => {
        /// Every section name. The registry is closed: adding one is a contract change.
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema, TS)]
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
    /// Model catalog; pages through `model/list` when stubbed.
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
    /// Desktop host state; key = `browserTabs` | `browserImport` | `visualize` | `displayPreferences` (desktop-published), or `remoteViewing` (core-published: the session ids paired devices show).
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
    /// Review summary of a thread; key = thread id (thread feed).
    ReviewDiff => "reviewDiff", "review/diff/updated", Thread, keyed: true;
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
}

/// Value above `INLINE_MAX` is replaced by a stub; the client pages the detail
/// with the section's list method.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct SectionStub {
    #[ts(type = "number")]
    pub count: u64,
    /// Always `true`.
    pub stub: bool,
}

/// Params of every section notification:
/// `{"section", "key", "revision", "value"}` or `{…, "removed": true}` or
/// `{…, "stub": {count, stub:true}}`. Exactly one of `value`, `removed`, `stub`.
/// The client keeps `(section,key)` iff `revision` is greater than the stored one.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
#[ts(optional_fields)]
pub struct SectionUpdate {
    pub section: SectionName,
    pub key: Option<String>,
    /// Per `(section,key)`, strictly increasing.
    #[ts(type = "number")]
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
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct RemotePairCode {
    /// Six digits, no separator.
    pub code: String,
    /// Epoch ms.
    #[ts(type = "number")]
    pub expires_at: i64,
}

/// Section value of `computer` (SPEC R40).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, JsonSchema, TS)]
#[serde(rename_all = "camelCase")]
pub struct ComputerSection {
    pub active: bool,
    pub observe_only: bool,
    pub controller: Option<String>,
    pub session_thread_id: Option<crate::ThreadId>,
}

impl Section for ComputerSection {
    const NAME: SectionName = SectionName::Computer;
    type Value = ComputerSection;
}
