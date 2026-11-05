//! Per-agent permissions (`ask|allow|block` per action kind) and the decision
//! audit. [`GrantTable`] holds the rules; [`GrantStore`] is the persistence
//! seam the gate reads and writes through (`<data>/human-gate/grants.json` and
//! `audit.jsonl`, format preserved by the store owner).
//!
//! A grant is keyed by agent + action; `agent` scope names the agent, `always`
//! stands for every agent (`*`), and an agent's own grant wins over an
//! every-agent one. `once` is never stored, and neither is `session` (that is
//! [`super::SessionGrants`]). Payments and permanent deletes are never allowed.
//! A tool key is only ever an every-agent `allow`.

use std::fmt;
use std::sync::Mutex;

use async_trait::async_trait;
use mixdog_protocol::ApprovalRemember;
use sha2::Digest;
use sha2::Sha256;

use super::action::GrantKey;

pub const ANY_AGENT: &str = "*";
pub(super) const FIELD_LIMIT: usize = 200;

/// Text of the refusal when a remote client would widen a permission.
pub const NO_WIDEN_MESSAGE: &str =
    "This change would widen what the bot may do without asking; make it on the desktop.";

/// Audit decisions the gate writes besides `approve`/`deny`/`timeout`.
pub const DEV_ALLOW_ALL_DECISION: &str = "dev-allow-all";
pub const SESSION_GRANTED_DECISION: &str = "session-granted";
pub const SESSION_REMEMBERED_DECISION: &str = "session-remembered";

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum PermissionMode {
    Ask,
    Allow,
    Block,
}

impl PermissionMode {
    const fn rank(self) -> u8 {
        match self {
            Self::Block => 0,
            Self::Ask => 1,
            Self::Allow => 2,
        }
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Ask => "ask",
            Self::Allow => "allow",
            Self::Block => "block",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        [Self::Ask, Self::Allow, Self::Block]
            .into_iter()
            .find(|mode| mode.as_str() == text)
    }
}

/// One stored `allow` or `block`.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct Grant {
    pub id: String,
    pub agent_id: String,
    pub action: GrantKey,
    pub mode: PermissionMode,
    pub device: String,
    pub at_ms: i64,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct PermissionRow {
    pub action: GrantKey,
    pub mode: PermissionMode,
    pub rememberable: bool,
    /// The allow is the every-agent one.
    pub shared: bool,
}

/// A remote client's change would have widened a permission.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct WouldWiden;

pub(super) use mixdog_js::cut_utf16;
pub(super) use mixdog_js::slice_utf16;

fn field(value: &str) -> String {
    slice_utf16(value, FIELD_LIMIT)
}

pub fn grant_id(agent_id: &str, action: &GrantKey) -> String {
    let digest = Sha256::digest(format!("{agent_id}\n{}", action.render()));
    let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    format!("grant_{}", &hex[..24])
}

fn valid(grant: &Grant) -> bool {
    match grant.mode {
        PermissionMode::Ask => false,
        PermissionMode::Allow => !grant.action.is_tool() || grant.agent_id == ANY_AGENT,
        PermissionMode::Block => !grant.action.is_tool(),
    }
}

#[derive(Clone, PartialEq, Eq, Debug, Default)]
pub struct GrantTable {
    grants: Vec<Grant>,
}

impl GrantTable {
    /// Rows read from storage; a row that cannot exist is dropped.
    pub fn from_rows(rows: impl IntoIterator<Item = Grant>) -> Self {
        Self {
            grants: rows.into_iter().filter(valid).collect(),
        }
    }

    pub fn rows(&self) -> &[Grant] {
        &self.grants
    }

    fn deciding(&self, agent_id: &str, action: &GrantKey, shared_only: bool) -> Option<&Grant> {
        let shared = self
            .grants
            .iter()
            .find(|g| &g.action == action && g.agent_id == ANY_AGENT);
        if shared_only {
            return shared;
        }
        self.grants
            .iter()
            .find(|g| &g.action == action && g.agent_id == agent_id)
            .or(shared)
    }

    /// The mode in force for `agent_id` + `action`; `shared_only` reads only
    /// the every-agent grant.
    pub fn mode_for(&self, agent_id: &str, action: &GrantKey, shared_only: bool) -> PermissionMode {
        match self.deciding(agent_id, action, shared_only) {
            Some(g) if g.mode == PermissionMode::Allow && !action.rememberable() => {
                PermissionMode::Ask
            }
            Some(g) => g.mode,
            None => PermissionMode::Ask,
        }
    }

    /// Sets `agent_id`'s mode for `action`; `Ask` removes its grant and, when
    /// it has none of its own, the every-agent allow its mode came from.
    /// Returns the stored grant, or `None` for `Ask` and for an `allow` or
    /// `block` that may not exist. With `no_widen` the change is refused when
    /// the effective mode would become more permissive.
    pub fn set_mode(
        &mut self,
        agent_id: &str,
        action: &GrantKey,
        mode: PermissionMode,
        device: &str,
        at_ms: i64,
        no_widen: bool,
    ) -> Result<Option<Grant>, WouldWiden> {
        if mode == PermissionMode::Allow && !action.rememberable() {
            return Ok(None);
        }
        let owner = field(agent_id);
        if action.is_tool()
            && (mode == PermissionMode::Block
                || (mode == PermissionMode::Allow && owner != ANY_AGENT))
        {
            return Ok(None);
        }
        let id = grant_id(&owner, action);
        let shared_id = grant_id(ANY_AGENT, action);
        let grant = (mode != PermissionMode::Ask).then(|| Grant {
            id: id.clone(),
            agent_id: owner.clone(),
            action: action.clone(),
            mode,
            device: field(device),
            at_ms,
        });
        let drops_shared = mode == PermissionMode::Ask
            && owner != ANY_AGENT
            && !self.grants.iter().any(|g| g.id == id)
            && self
                .grants
                .iter()
                .any(|g| g.id == shared_id && g.mode == PermissionMode::Allow);
        let mut next: Vec<Grant> = self
            .grants
            .iter()
            .filter(|g| g.id != id && !(drops_shared && g.id == shared_id))
            .cloned()
            .collect();
        next.extend(grant.clone());
        if no_widen {
            let after = Self { grants: next.clone() }.mode_for(&owner, action, false);
            if after.rank() > self.mode_for(&owner, action, false).rank() {
                return Err(WouldWiden);
            }
        }
        self.grants = next;
        Ok(grant)
    }

    /// Stores an `allow` for scope `agent` (this agent) or `always` (every
    /// agent); `once` and `session` store nothing.
    pub fn grant(
        &mut self,
        agent_id: &str,
        action: &GrantKey,
        scope: ApprovalRemember,
        device: &str,
        at_ms: i64,
    ) -> Option<Grant> {
        let owner = match scope {
            ApprovalRemember::Agent => agent_id,
            ApprovalRemember::Always => ANY_AGENT,
            ApprovalRemember::Once | ApprovalRemember::Session => return None,
        };
        self.set_mode(owner, action, PermissionMode::Allow, device, at_ms, false)
            .ok()
            .flatten()
    }

    /// The profile's permission table for `agent_id`: every action kind with
    /// its mode, then one row per tool allowed for every agent.
    pub fn permissions(&self, agent_id: &str) -> Vec<PermissionRow> {
        let mut rows: Vec<PermissionRow> = mixdog_core_api::domain::approval::ActionKind::ALL
            .into_iter()
            .map(|kind| {
                let action = GrantKey::Kind(kind);
                let mode = self.mode_for(agent_id, &action, false);
                let shared = mode == PermissionMode::Allow
                    && self
                        .deciding(agent_id, &action, false)
                        .is_some_and(|g| g.agent_id == ANY_AGENT);
                PermissionRow {
                    rememberable: action.rememberable(),
                    action,
                    mode,
                    shared,
                }
            })
            .collect();
        rows.extend(self.grants.iter().filter(|g| g.action.is_tool()).map(|g| {
            PermissionRow {
                action: g.action.clone(),
                mode: PermissionMode::Allow,
                rememberable: true,
                shared: true,
            }
        }));
        rows
    }

    /// Grants that apply to `agent_id` (its own and every-agent ones).
    pub fn applying_to(&self, agent_id: &str) -> Vec<Grant> {
        self.grants
            .iter()
            .filter(|g| g.agent_id == agent_id || g.agent_id == ANY_AGENT)
            .cloned()
            .collect()
    }

    pub fn revoke(&mut self, id: &str) -> bool {
        let before = self.grants.len();
        self.grants.retain(|g| g.id != id);
        self.grants.len() != before
    }
}

/// One audit line: who, what kind of decision, never a value or payload.
#[derive(Clone, PartialEq, Eq, Debug, Default)]
pub struct AuditEntry {
    pub agent_id: String,
    pub kind: String,
    pub action: String,
    pub tool: String,
    pub target: String,
    pub decision: String,
    pub device: String,
    pub at_ms: Option<i64>,
}

impl AuditEntry {
    /// Every text field cut to the stored length.
    pub fn limited(self) -> Self {
        Self {
            agent_id: field(&self.agent_id),
            kind: field(&self.kind),
            action: field(&self.action),
            tool: field(&self.tool),
            target: field(&self.target),
            decision: field(&self.decision),
            device: field(&self.device),
            at_ms: self.at_ms,
        }
    }
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct StoreError(pub String);

impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for StoreError {}

/// Persistence of grants and audit. A read failure is an error, never "no
/// grant": the gate fails closed.
#[async_trait]
pub trait GrantStore: Send + Sync {
    async fn mode_for(
        &self,
        agent_id: &str,
        action: &GrantKey,
        shared_only: bool,
    ) -> Result<PermissionMode, StoreError>;

    /// Stores an `allow` for `agent` / `always` scope; returns whether one was
    /// stored.
    async fn grant(
        &self,
        agent_id: &str,
        action: &GrantKey,
        scope: ApprovalRemember,
        device: &str,
    ) -> Result<bool, StoreError>;

    async fn record_audit(&self, entry: AuditEntry) -> Result<(), StoreError>;
}

/// In-memory store: tests and tools that run without a data dir.
#[derive(Default)]
pub struct MemoryGrantStore {
    table: Mutex<GrantTable>,
    audit: Mutex<Vec<AuditEntry>>,
}

impl MemoryGrantStore {
    pub fn with_table(table: GrantTable) -> Self {
        Self {
            table: Mutex::new(table),
            audit: Mutex::default(),
        }
    }

    pub fn set_mode(&self, agent_id: &str, action: &GrantKey, mode: PermissionMode) {
        let mut table = self.table.lock().expect("grant table");
        let _ = table.set_mode(agent_id, action, mode, "", 0, false);
    }

    pub fn audit(&self) -> Vec<AuditEntry> {
        self.audit.lock().expect("audit").clone()
    }
}

#[async_trait]
impl GrantStore for MemoryGrantStore {
    async fn mode_for(
        &self,
        agent_id: &str,
        action: &GrantKey,
        shared_only: bool,
    ) -> Result<PermissionMode, StoreError> {
        Ok(self
            .table
            .lock()
            .expect("grant table")
            .mode_for(agent_id, action, shared_only))
    }

    async fn grant(
        &self,
        agent_id: &str,
        action: &GrantKey,
        scope: ApprovalRemember,
        device: &str,
    ) -> Result<bool, StoreError> {
        Ok(self
            .table
            .lock()
            .expect("grant table")
            .grant(agent_id, action, scope, device, 0)
            .is_some())
    }

    async fn record_audit(&self, entry: AuditEntry) -> Result<(), StoreError> {
        self.audit.lock().expect("audit").push(entry.limited());
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use mixdog_core_api::domain::approval::ActionKind;

    /// Regression: limits count UTF-16 units like `String.prototype.slice`, not scalars.
    #[test]
    fn a_field_is_cut_by_utf16_units_like_javascript() {
        let emoji = "😀".repeat(201);
        // 100 whole pairs fit in 200 units, so 100 emoji stay (not 200).
        assert_eq!(super::field(&emoji), "😀".repeat(100));
        // An odd limit lands inside a pair: JavaScript keeps the high surrogate alone.
        let cut = super::cut_utf16(&emoji, 201);
        assert_eq!(cut.head, "😀".repeat(100));
        assert_eq!(cut.dangling_high, Some(0xD83D));
        assert_eq!(super::slice_utf16(&emoji, 201), format!("{}\u{fffd}", "😀".repeat(100)));
        // BMP text is unchanged by the unit count, and short text is returned whole.
        assert_eq!(super::field(&"é".repeat(250)), "é".repeat(200));
        assert_eq!(super::cut_utf16("ab😀", 3).dangling_high, Some(0xD83D));
        assert_eq!(super::cut_utf16("ab😀", 4).dangling_high, None);
        assert_eq!(super::field("short"), "short");
    }

    use super::*;

    fn kind(kind: ActionKind) -> GrantKey {
        GrantKey::Kind(kind)
    }

    #[test]
    fn an_agents_own_grant_wins_over_the_every_agent_one() {
        let mut table = GrantTable::default();
        table
            .grant("a", &kind(ActionKind::Comment), ApprovalRemember::Always, "", 1)
            .expect("shared allow");
        assert_eq!(
            table.mode_for("b", &kind(ActionKind::Comment), false),
            PermissionMode::Allow
        );
        table
            .set_mode("b", &kind(ActionKind::Comment), PermissionMode::Block, "", 2, false)
            .expect("set");
        assert_eq!(
            table.mode_for("b", &kind(ActionKind::Comment), false),
            PermissionMode::Block
        );
        assert_eq!(
            table.mode_for("b", &kind(ActionKind::Comment), true),
            PermissionMode::Allow
        );
    }

    #[test]
    fn payments_and_deletes_can_never_be_allowed() {
        let mut table = GrantTable::default();
        for k in [ActionKind::Payment, ActionKind::Delete] {
            assert_eq!(
                table.set_mode("a", &kind(k), PermissionMode::Allow, "", 0, false),
                Ok(None)
            );
            assert_eq!(table.mode_for("a", &kind(k), false), PermissionMode::Ask);
        }
        // A block is still storable.
        assert!(
            table
                .set_mode("a", &kind(ActionKind::Payment), PermissionMode::Block, "", 0, false)
                .expect("set")
                .is_some()
        );
    }

    #[test]
    fn once_and_session_scopes_store_nothing() {
        let mut table = GrantTable::default();
        for scope in [ApprovalRemember::Once, ApprovalRemember::Session] {
            assert_eq!(table.grant("a", &kind(ActionKind::Email), scope, "", 0), None);
        }
        assert!(table.rows().is_empty());
    }

    #[test]
    fn a_tool_is_only_ever_allowed_for_every_agent_and_never_blocked() {
        let mut table = GrantTable::default();
        let shell = GrantKey::tool("shell").expect("key");
        assert_eq!(table.grant("a", &shell, ApprovalRemember::Agent, "", 0), None);
        assert_eq!(
            table.set_mode("*", &shell, PermissionMode::Block, "", 0, false),
            Ok(None)
        );
        assert!(table.grant("a", &shell, ApprovalRemember::Always, "", 0).is_some());
        assert_eq!(table.mode_for("z", &shell, false), PermissionMode::Allow);
        // The same revoke ("ask") by any agent turns the shared row back to asking.
        table
            .set_mode("z", &shell, PermissionMode::Ask, "", 1, false)
            .expect("ask");
        assert_eq!(table.mode_for("z", &shell, false), PermissionMode::Ask);
        assert!(table.rows().is_empty());
    }

    #[test]
    fn no_widen_refuses_lifting_a_block_and_leaves_the_table_unchanged() {
        let mut table = GrantTable::default();
        table
            .set_mode("a", &kind(ActionKind::Email), PermissionMode::Block, "", 0, false)
            .expect("block");
        let before = table.clone();
        assert_eq!(
            table.set_mode("a", &kind(ActionKind::Email), PermissionMode::Allow, "", 1, true),
            Err(WouldWiden)
        );
        assert_eq!(table, before);
        // Back to asking also lifts the block; keeping it is allowed.
        assert_eq!(
            table.set_mode("a", &kind(ActionKind::Email), PermissionMode::Ask, "", 2, true),
            Err(WouldWiden)
        );
        assert!(
            table
                .set_mode("a", &kind(ActionKind::Email), PermissionMode::Block, "", 3, true)
                .is_ok()
        );
    }

    #[test]
    fn grant_ids_are_stable_24_hex_digests_of_agent_and_action() {
        let id = grant_id("a", &kind(ActionKind::Email));
        assert!(id.starts_with("grant_"));
        assert_eq!(id.len(), "grant_".len() + 24);
        assert_eq!(id, grant_id("a", &kind(ActionKind::Email)));
        assert_ne!(id, grant_id("b", &kind(ActionKind::Email)));
    }

    #[test]
    fn the_permission_table_lists_every_kind_then_shared_tool_rows() {
        let mut table = GrantTable::default();
        table.grant("a", &GrantKey::tool("shell").expect("key"), ApprovalRemember::Always, "", 0);
        table.grant("a", &kind(ActionKind::Form), ApprovalRemember::Always, "", 0);
        let rows = table.permissions("x");
        assert_eq!(rows.len(), ActionKind::ALL.len() + 1);
        let form = rows.iter().find(|r| r.action == kind(ActionKind::Form)).expect("form");
        assert!(form.shared && form.mode == PermissionMode::Allow);
        assert_eq!(rows.last().map(|r| r.action.render()), Some("tool:shell".to_owned()));
    }

    #[test]
    fn rows_that_cannot_exist_are_dropped_on_load() {
        let bad = Grant {
            id: "x".into(),
            agent_id: "a".into(),
            action: GrantKey::Tool("shell".into()),
            mode: PermissionMode::Allow,
            device: String::new(),
            at_ms: 0,
        };
        assert!(GrantTable::from_rows([bad]).rows().is_empty());
    }
}
