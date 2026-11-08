//! One-time migration bookkeeping (FORMAT.md §10): manifest, framed journal, item state
//! machine, completion marker and quarantine reason. One shape for every kind, including
//! the Electron-profile kind group `desktopProfile` (SPEC §4.11).

use serde::Deserialize;
use serde::Serialize;

use super::bounded::Digest;
use super::bounded::ITEM_KEY_MAX;
use super::bounded::SHA256_HEX_MAX;
use super::bounded::Text;

/// A manifest item key; bounded so every journal entry fits one frame.
pub type ItemKey = Text<ITEM_KEY_MAX>;

pub const MANIFEST_FORMAT: u32 = 1;
pub const COMPLETE_FORMAT: u32 = 1;
pub const REASON_FORMAT: u32 = 1;
/// Paths relative to `<D>`.
pub const MANIFEST_PATH: &str = "migration/manifest.json";
/// The journal is one framed file, `migration/journal.000000`, ordinals from 0.
pub const JOURNAL_PATH: &str = "migration/journal.000000";
pub const STAGE_DIR: &str = "migration/stage";
pub const COMPLETE_PATH: &str = "migration/complete.json";
/// The manifest and journal of the late desktop-profile pass: a migration that completed with
/// no profile named, run again with one. `complete.json` names the manifest it completed
/// (this one once the pass is done), so the profile it records is the manifest's `roots.profile`.
pub const LATE_MANIFEST_PATH: &str = "migration/late-manifest.json";
pub const LATE_JOURNAL_PATH: &str = "migration/late-journal.000000";
/// `quarantine/<code>/<escaped key>/{reason.json, <moved files>}`.
pub const QUARANTINE_DIR: &str = "quarantine";
pub const REASON_FILE: &str = "reason.json";

/// `migration/manifest.json`, published before the journal's `plan` frame.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Manifest {
    pub format: u32,
    pub roots: Roots,
    /// Sorted by `key`.
    pub items: Vec<ManifestItem>,
    /// Files read by more than one item, sorted by `(root, path)`. A shared file is
    /// disposed when every consumer is `disposed`.
    pub shared: Vec<SharedSource>,
}

/// Absolute roots the relative source paths resolve against.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Roots {
    /// `<D>`.
    pub data: String,
    /// `<H>` = `~/.mixdog` (holds `projects.json`).
    pub home: String,
    /// `<P>`, the Electron profile; absent when the data dir has none.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Root {
    Data,
    Home,
    Profile,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SourceFile {
    pub root: Root,
    /// Relative to the root, `/`-separated, no `.`/`..` segments.
    pub path: String,
    pub size: u64,
    /// 64 lowercase hex.
    pub sha256: String,
    /// Credential-bearing (class C): hashed here, never logged, moved with owner-only access.
    pub secret: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SharedSource {
    pub file: SourceFile,
    /// Item keys, sorted.
    pub consumers: Vec<String>,
}

/// One unit of planning, conversion, verification and disposal.
///
/// Keys: `session/<id>`, `store/<kind>`, `ledger`, `index`, `retire/<root>/<path>`,
/// `retain/<root>/<path>`, `desktopProfile/<kind>`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ManifestItem {
    pub key: ItemKey,
    pub group: KindGroup,
    pub kind: ItemKind,
    pub contract: Contract,
    /// Files this item alone owns, sorted by `(root, path)`.
    pub sources: Vec<SourceFile>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<Target>,
}

/// Completion is reported per group (`complete.json.kinds`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum KindGroup {
    /// Everything under `<D>` and `<H>`.
    Data,
    /// The Electron profile `<P>` (SPEC §4.11).
    DesktopProfile,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Contract {
    /// Becomes session-log records, SQLite rows or config keys.
    Convert,
    /// Bytes unchanged (in place, or moved to `target`).
    Preserve,
    /// Deleted at disposal.
    Retire,
    /// Moved to quarantine with an expected reason.
    Retain,
}

/// Every kind the planner can produce. The allowed contract per kind is in FORMAT.md §10.2.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ItemKind {
    // ── group `data`, converted ──
    /// 1.4.5 json, dev log, or the json+log pair, with archive, pending archive, turn
    /// checkpoints; consumes shared pending spools, worker indexes and profile metadata.
    Session,
    /// `usage/ledger.sqlite` converted in place to `user_version` 3.
    Ledger,
    /// `index/store.sqlite` built from every published session.
    Index,
    // ── group `data`, preserved ──
    AttachmentBlobs,
    Goals,
    QuotaResume,
    HumanGate,
    ConnectorAccounts,
    GatewaySessionRoutes,
    PromptCacheTouches,
    PromptCacheIdleGaps,
    Heartbeat,
    RoutineResults,
    Media,
    LedgerBackups,
    Settings,
    CoreMemory,
    ProjectsRegistry,
    Agents,
    Bots,
    Workflows,
    Schedules,
    Hooks,
    Skills,
    Plugins,
    McpConfig,
    ProjectConnectors,
    TuiPromptHistory,
    Worktrees,
    // ── group `data`, retired or retained ──
    /// Turn checkpoints whose session has no session item.
    OrphanCheckpoint,
    /// `usage-rollup.local.json`, `gateway-usage.local.json[l]`: retired when the ledger's
    /// `metadata.importedThrough` exists, else retained `ledger_import_incomplete`.
    LedgerLegacyInputs,
    // ── group `desktopProfile` (SPEC §4.11), converted ──
    /// `desktop-session-metadata.json`: per-session `meta` records; entries naming no
    /// migrated session retire, counted.
    SessionMetadata,
    /// `desktop-projects.json` → `state/core.sqlite` `projects`.
    DesktopProjects,
    /// `agent-rooms.json` → `state/core.sqlite` `rooms`.
    AgentRooms,
    /// `agent-greetings.json` → config `agents.greeted`.
    AgentGreetings,
    /// `notification-preferences.json` → config `notifications`.
    NotificationPreferences,
    /// `session-auto-retention.json` → config `desktop.retentionState`.
    RetentionState,
    /// `remote-activated.json` → config `remote.activatedAt`.
    RemoteActivated,
    // ── group `desktopProfile`, preserved (moved) ──
    RemoteAccessSettings,
    RemoteClients,
    RelayDevice,
    RelayDeviceRevocations,
    RelayE2ee,
    PairingToken,
    NativePush,
    PcAccessRevokes,
    SelectedFileGrants,
    EditorBackups,
    EditorRecovery,
    /// `workspace/unclassified/` stays in place; its path becomes config
    /// `desktop.unclassifiedWorkspaceRoot`.
    UnclassifiedWorkspace,
    /// `remote-push.json`: retired (U-DS2), or its relay-path subset preserved.
    WebPush,
    // ── both groups ──
    /// Derived, cache, tmp, backup and bookkeeping files (one item per path).
    Retired,
    /// Files 1.4.5/dev already set aside (`carried_set_aside`, one item per path).
    SetAside,
}

/// Where a converted or moved item lands.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub enum Target {
    /// `<D>/sessions/<id>/`.
    Session { id: String },
    /// Records inside many session logs (shared converts).
    Sessions,
    /// A file or directory (preserve-move destination; equals the source for in place).
    File { root: Root, path: String },
    /// A table of `state/core.sqlite`.
    StateTable { table: StateTable },
    /// A key path of `<D>/mixdog-config.json`.
    ConfigKey { key: String },
    /// `<D>/usage/ledger.sqlite`, in place.
    Ledger,
    /// `<D>/index/store.sqlite`.
    Index,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StateTable {
    Projects,
    Rooms,
}

/// Per-item states. `staged`/`published` are no-ops journaled for uniformity on preserve
/// items; retire items go `planned → verified → disposed`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ItemState {
    Planned,
    Staged,
    Published,
    Verified,
    Quarantined,
    Disposed,
}

impl ItemState {
    /// The item state machine (FORMAT.md §10.5); every other pair is a journal violation.
    pub const fn can_advance(self, to: ItemState) -> bool {
        use ItemState::*;
        matches!(
            (self, to),
            (Planned, Staged)
                | (Planned, Verified)
                | (Planned, Quarantined)
                | (Staged, Published)
                | (Staged, Quarantined)
                | (Published, Verified)
                | (Published, Quarantined)
                | (Verified, Disposed)
                | (Quarantined, Disposed)
        )
    }
}

/// Journal frame payloads (`k` first, as session records).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "k", rename_all = "snake_case")]
pub enum JournalRecord {
    /// Ordinal 0: every manifest item enters `planned`.
    Plan(PlanEntry),
    Staged(StagedEntry),
    Published(KeyEntry),
    Verified(VerifiedEntry),
    Quarantined(QuarantinedEntry),
    Disposed(KeyEntry),
    Phase(PhaseEntry),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PlanEntry {
    pub manifest_sha256: Text<SHA256_HEX_MAX>,
    pub items: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct StagedEntry {
    pub key: ItemKey,
    /// SHA-256 of the staged output (the `log.*` files in order for a session).
    pub output_sha256: Text<SHA256_HEX_MAX>,
    /// Lone UTF-16 surrogates in the source text replaced by U+FFFD (FORMAT.md §10.9);
    /// 0 for preserve and retire items.
    pub replaced_surrogates: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct KeyEntry {
    pub key: ItemKey,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VerifiedEntry {
    pub key: ItemKey,
    /// `sha256:` digest of the verified observable state; absent for retire items.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub digest: Option<Digest>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct QuarantinedEntry {
    pub key: ItemKey,
    pub code: QuarantineCode,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PhaseEntry {
    pub phase: Phase,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    /// Every item is `verified` or `quarantined`; disposal may start.
    VerifiedAll,
}

/// `migration/complete.json`; the runtime checks only this file before `Serving`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Complete {
    pub format: u32,
    pub manifest_sha256: String,
    pub journal_end_ordinal: u64,
    pub kinds: CompleteKinds,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CompleteKinds {
    pub data: Counts,
    #[serde(rename = "desktopProfile")]
    pub desktop_profile: Counts,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Counts {
    pub verified: u64,
    pub quarantined_expected: u64,
    pub quarantined_unexpected: u64,
    pub retired: u64,
    pub retained: u64,
    pub dangling: u64,
}

/// `quarantine/<code>/<escaped key>/reason.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct QuarantineReason {
    pub format: u32,
    pub key: String,
    pub code: QuarantineCode,
    /// Equals `code.expected()`; written so an exported folder explains itself.
    pub expected: bool,
    pub detail: String,
    pub sources: Vec<QuarantinedSource>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct QuarantinedSource {
    pub root: Root,
    /// Original path; the file sits in the quarantine folder under its base name.
    pub path: String,
    pub sha256: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QuarantineCode {
    CarriedSetAside,
    LedgerImportIncomplete,
    ParseError,
    SchemaViolation,
    IdMismatch,
    ItemTooLarge,
    ArchiveParseError,
    DigestMismatch,
    /// Runtime repair of a damaged session log (FORMAT.md §3.4), not a migration code.
    SessionDamage,
}

impl QuarantineCode {
    /// Expected quarantines do not fail the release gate.
    pub const fn expected(self) -> bool {
        matches!(
            self,
            QuarantineCode::CarriedSetAside | QuarantineCode::LedgerImportIncomplete
        )
    }
}
