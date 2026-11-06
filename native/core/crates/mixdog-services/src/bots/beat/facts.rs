//! What the heartbeat reads to build its digest (mixy-heartbeat.mjs `collectHeartbeatFacts`,
//! bot-status.mjs `scanCatalog`): the session catalog, the report watches of task turns, the held
//! requests and the automation store. Every source must answer: a check built on part of them is
//! not committed.

use std::sync::Arc;

use async_trait::async_trait;
use mixdog_core_base::rooms::ids::{MIXY_AGENT_ID, agent_home_session_id, agent_id_of_home_session, room_id_of_session, room_member_of_session};

use super::digest::{Entry, Facts, RoutineFact};
use crate::bots::routine::{HEARTBEAT_SOURCE, RoutineKind};
use crate::bots::runtime::RoutineRecords;

/// Catalog rows read per page.
const SCAN_PAGE: usize = 200;
/// At most this many rows are scanned for a digest.
const SCAN_ROWS: usize = 400;

/// A session catalog row, as far as the heartbeat reads it.
#[derive(Clone, Debug, PartialEq, Default)]
pub struct CatalogRow {
    pub id: String,
    pub title: String,
    pub last_message_preview: String,
    pub preview: String,
    pub last_used_at: i64,
    pub updated_at: i64,
    /// A turn runs now (`working`, or `agentWorking` for an agent's session).
    pub working: bool,
    pub agent_working: bool,
    pub source_name: String,
    pub source_type: String,
    pub owner: String,
    pub visibility: String,
    /// `isRootLeadSession(row)` (store-summary-visibility.mjs): a root Lead stays a user-facing
    /// session even with the agent ownership a recovery may leave.
    pub root_lead: bool,
}

impl CatalogRow {
    /// `activityOf`: the row's last activity (epoch ms), 0 when unknown.
    pub fn activity(&self) -> i64 {
        if self.last_used_at != 0 { self.last_used_at } else { self.updated_at }
    }

    /// `isWorking`.
    pub fn is_working(&self) -> bool {
        self.working || self.agent_working
    }

    /// `sessionBotOf`: the bot a row belongs to: its home chat, room seat or task origin; empty
    /// for none. A task session's creator is stamped in `sourceName` by the host
    /// (`agent:<id>@home|@room|@run`, older ones without the suffix).
    pub fn bot(&self) -> String {
        if let Some(agent) = agent_id_of_home_session(&self.id) {
            return agent;
        }
        if let Some(member) = room_member_of_session(&self.id) {
            return member.agent_id;
        }
        task_origin(&self.source_name).unwrap_or_default()
    }

    /// A session the user talks in: a Lead session or a bot's chat; never an exec run (a
    /// heartbeat's included), a delegated agent, a task session or a room seat.
    fn user_facing(&self) -> bool {
        self.source_name != HEARTBEAT_SOURCE
            && self.source_type.to_lowercase() != "exec"
            && (self.owner != "agent" || self.root_lead)
            && self.visibility != "agent-only"
            && (self.bot().is_empty() || agent_id_of_home_session(&self.id).is_some())
    }
}

/// `/^agent:([a-z0-9][a-z0-9.-]*)(?:@(?:home|room|run))?$/`.
fn task_origin(source_name: &str) -> Option<String> {
    let rest = source_name.strip_prefix("agent:")?;
    let id = ["@home", "@room", "@run"].iter().find_map(|suffix| rest.strip_suffix(suffix)).unwrap_or(rest);
    let mut chars = id.chars();
    let first = chars.next()?;
    let valid = (first.is_ascii_lowercase() || first.is_ascii_digit())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '-');
    valid.then(|| id.to_owned())
}

#[derive(Clone, Debug, PartialEq, Default)]
pub struct CatalogPage {
    pub sessions: Vec<CatalogRow>,
    /// The cursor of the next page; `None` at the end.
    pub next_cursor: Option<String>,
}

/// The session service as the heartbeat reads it.
#[async_trait]
pub trait SessionCatalog: Send + Sync {
    /// `listSessionCatalog({ page: { limit, cursor } })`, newest first.
    async fn page(&self, limit: usize, cursor: Option<&str>) -> Result<CatalogPage, String>;
    /// `liveSessionAwaitingApproval(id) === true`.
    fn awaiting_approval(&self, session_id: &str) -> bool;
}

/// The reporting turns whose report is not queued yet (`agentTaskWatches`).
#[async_trait]
pub trait TaskWatches: Send + Sync {
    async fn task_session_ids(&self) -> Result<Vec<String>, String>;
}

/// The held requests of unattended runs (`pendingHeldRequests`).
#[async_trait]
pub trait HeldRequests: Send + Sync {
    async fn pending(&self) -> Result<usize, String>;
}

/// What a scan kept.
struct Scan {
    rows: Vec<CatalogRow>,
}

/// `scanCatalog`: the rows `keep` admits, newest first, in pages, after at most `SCAN_ROWS`
/// scanned.
async fn scan_catalog(catalog: &dyn SessionCatalog, keep: impl Fn(&CatalogRow) -> bool) -> Result<Scan, String> {
    let mut rows = Vec::new();
    let mut scanned = 0;
    let mut next: Option<String> = None;
    loop {
        let page = catalog.page(SCAN_PAGE.min(SCAN_ROWS - scanned), next.as_deref()).await?;
        next = if page.sessions.is_empty() { None } else { page.next_cursor };
        for row in page.sessions {
            scanned += 1;
            if keep(&row) {
                rows.push(row);
            }
        }
        if next.is_none() || scanned >= SCAN_ROWS {
            return Ok(Scan { rows });
        }
    }
}

pub struct FactSources {
    pub catalog: Arc<dyn SessionCatalog>,
    pub watches: Arc<dyn TaskWatches>,
    pub held: Arc<dyn HeldRequests>,
    /// The automation store.
    pub routines: Arc<dyn RoutineRecords>,
}

impl FactSources {
    /// What happened since `since`. Rejects when any source cannot be read.
    pub async fn collect(&self, since: i64) -> Result<Facts, String> {
        let watched: std::collections::HashSet<String> = self.watches.task_session_ids().await?.into_iter().filter(|id| !id.is_empty()).collect();
        // A heartbeat's hidden session is an exec run the catalog never lists; its source keeps
        // it out here too.
        let scan = scan_catalog(self.catalog.as_ref(), |row| {
            row.source_name != HEARTBEAT_SOURCE && room_member_of_session(&row.id).is_none() && row.activity() > since
        })
        .await?;
        let home = agent_home_session_id(MIXY_AGENT_ID).unwrap_or_default();
        let mut sessions = Vec::new();
        let mut tasks = Vec::new();
        for row in &scan.rows {
            let bot = row.bot();
            let entry = Entry {
                id: row.id.clone(),
                bot: bot.clone(),
                title: row.title.clone(),
                preview: if row.last_message_preview.is_empty() { row.preview.clone() } else { row.last_message_preview.clone() },
                room: false,
            };
            if bot.is_empty() || agent_id_of_home_session(&row.id).is_some() {
                // Only a session the user talks in: never an exec or memory run or a Lead's
                // delegated agent. Mixy's own chat is hers and the user's: it is never news to her.
                let room = room_id_of_session(&row.id).is_some();
                if row.id != home && row.user_facing() {
                    sessions.push(Entry { room, ..entry });
                }
            } else if !(row.is_working() || watched.contains(&row.id)) {
                tasks.push(entry);
            }
            // A task session still working is told once it finishes.
        }
        let held = self.held.pending().await?;
        let approvals = held + scan.rows.iter().filter(|row| self.catalog.awaiting_approval(&row.id)).count();
        let mut routines = Vec::new();
        for kind in [RoutineKind::Schedule, RoutineKind::Webhook] {
            for row in self.routines.list(kind).await? {
                routines.push(RoutineFact { kind, name: row.name, enabled: row.enabled, failures: row.consecutive_failures });
            }
        }
        Ok(Facts { sessions, tasks, approvals: approvals as u64, routines })
    }
}
