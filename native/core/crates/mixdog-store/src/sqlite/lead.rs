//! The lead-visible catalog listing: the store half of `thread/list` (1.4.5
//! `listStoredSessionSummaryPage`, store-summary-reader.mjs, answered by the catalog DB's
//! `lead_visible = 1` rows in `activity DESC, id ASC` order: worker.mjs `listFirst`/`listAfter`).
//!
//! The 1.4.5 catalog DB stores `lead_visible` (`isLeadVisibleRow`) as a column. This index has
//! no such column, so [`SqliteStore::lead_page`] reads the rows in the same order and keeps the
//! lead-visible ones, which is the same set (the predicate reads only the list row).

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use rusqlite::params;
use serde_json::Map;
use serde_json::Value;
use serde_json::json;

use super::DbError;
use super::SqliteStore;
use crate::summary::clean;
use crate::summary::get;
use crate::summary::is_root_lead_session;
use crate::summary::session_visibility;
use crate::summary::truthy;

/// The keyset position after a row: its activity and id (`decodeCatalogCursor`'s result).
#[derive(Debug, Clone, PartialEq)]
pub struct CatalogCursor {
    pub activity: f64,
    pub id: String,
}

/// A cursor that is not an earlier page's `nextCursor` (`EINVALIDCURSOR`).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("invalid session catalog cursor")]
pub struct InvalidCursor;

/// `activityOf(row)`: `row.lastUsedAt || row.updatedAt || 0`.
pub fn activity_of(row: &Map<String, Value>) -> f64 {
    let number = |key: &str| get(row, key).filter(|v| truthy(Some(v))).and_then(Value::as_f64);
    number("lastUsedAt").or_else(|| number("updatedAt")).unwrap_or(0.0)
}

/// `encodeCatalogCursor(row)`: base64url of `[activity, id]`.
pub fn encode_catalog_cursor(row: &Map<String, Value>) -> String {
    let id = get(row, "id").and_then(Value::as_str).unwrap_or_default();
    let body = serde_json::to_string(&json!([mixdog_js::json_number(activity_of(row)), id])).expect("a cursor serializes");
    URL_SAFE_NO_PAD.encode(body)
}

/// `decodeCatalogCursor(cursor)`: `None` for none (absent or empty), an error for a malformed one.
pub fn decode_catalog_cursor(cursor: Option<&str>) -> Result<Option<CatalogCursor>, InvalidCursor> {
    let Some(cursor) = cursor.filter(|c| !c.is_empty()) else { return Ok(None) };
    let bytes = URL_SAFE_NO_PAD.decode(cursor).map_err(|_| InvalidCursor)?;
    let parsed: Value = serde_json::from_slice(&bytes).map_err(|_| InvalidCursor)?;
    match parsed.as_array().map(Vec::as_slice) {
        // `Number.isFinite(parsed[0]) && typeof parsed[1] === 'string'`; extra elements are ignored.
        Some([Value::Number(activity), Value::String(id), ..]) => {
            Ok(Some(CatalogCursor { activity: activity.as_f64().ok_or(InvalidCursor)?, id: id.clone() }))
        }
        _ => Err(InvalidCursor),
    }
}

/// `isLeadVisibleRow(row)` (store-summary-catalog.mjs) over a list row.
pub fn is_lead_visible_row(row: &Map<String, Value>) -> bool {
    let lower = |key: &str| clean(Some(&get(row, key).filter(|v| truthy(Some(v))).cloned().unwrap_or(Value::Null))).to_lowercase();
    let owner = clean(Some(&get(row, "owner").filter(|v| truthy(Some(v))).cloned().unwrap_or_else(|| json!("user")))).to_lowercase();
    let agent_session = session_visibility(row) == "agent-only" || owner == "agent";
    if !agent_session && !is_root_lead_session(row) && !owner.is_empty() && !["cli", "user", "mixdog"].contains(&owner.as_str()) {
        return false;
    }
    // A previewless zero-message row with no title is unusable scratch.
    if !truthy(get(row, "preview")) && get(row, "messageCount").and_then(Value::as_f64) == Some(0.0) && !truthy(get(row, "title")) {
        return false;
    }
    let source_type = lower("sourceType");
    if source_type == "exec" {
        return false;
    }
    agent_session
        || lower("agent") == "lead"
        || ["lead", "cli", "schedule", "webhook"].contains(&source_type.as_str())
        || (source_type.is_empty() && lower("sourceName").is_empty() && owner != "agent")
}

/// One listed session: its list row and the archived flag the index keeps beside it.
#[derive(Debug, Clone, PartialEq)]
pub struct LeadRow {
    pub row: Map<String, Value>,
    pub archived: bool,
}

/// What a listing keeps beyond lead visibility (`thread/list`'s `archived` and `cwd`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LeadFilter {
    /// `Some(flag)`: only rows whose archived flag is `flag`.
    pub archived: Option<bool>,
    /// Only rows whose list-row `cwd` is exactly this.
    pub cwd: Option<String>,
}

impl LeadFilter {
    fn keeps(&self, row: &LeadRow) -> bool {
        self.archived.is_none_or(|archived| row.archived == archived)
            && self.cwd.as_deref().is_none_or(|cwd| get(&row.row, "cwd").and_then(Value::as_str) == Some(cwd))
    }
}

/// One page of the lead-visible listing.
#[derive(Debug, Clone, PartialEq)]
pub struct LeadPage {
    /// The listed sessions, newest activity first, ties by id.
    pub rows: Vec<LeadRow>,
    /// Whether lead-visible rows follow the last one.
    pub more: bool,
}

/// The page [`SqliteStore::lead_page`] answers, over list rows already in hand (a store with no
/// index): the lead-visible rows after `after` in `activity DESC, id ASC` order.
pub fn lead_page_of(rows: Vec<LeadRow>, after: Option<&CatalogCursor>, filter: &LeadFilter, limit: usize) -> LeadPage {
    let mut kept: Vec<(f64, LeadRow)> = rows
        .into_iter()
        .filter(|row| is_lead_visible_row(&row.row) && filter.keeps(row))
        .map(|row| (activity_of(&row.row), row))
        .filter(|(activity, row)| {
            after.is_none_or(|after| *activity < after.activity || (*activity == after.activity && row.row["id"].as_str().unwrap_or_default() > after.id.as_str()))
        })
        .collect();
    kept.sort_by(|(left, a), (right, b)| {
        right.total_cmp(left).then_with(|| a.row["id"].as_str().unwrap_or_default().cmp(b.row["id"].as_str().unwrap_or_default()))
    });
    let more = kept.len() > limit;
    LeadPage { rows: kept.into_iter().take(limit).map(|(_, row)| row).collect(), more }
}
/// Rows read from the table per round trip while looking for lead-visible ones.
const SCAN_BATCH: usize = 256;

const SCAN_SQL: &str = "SELECT summary, activity, id, archived FROM sessions
     WHERE deleted = 0 AND (?1 IS NULL OR activity < ?1 OR (activity = ?1 AND id > ?2))
     ORDER BY activity DESC, id ASC LIMIT ?3";

impl SqliteStore {
    /// `limit` lead-visible rows that pass `filter`, after `after` (`listAfter`; from the top when
    /// `None`), and whether more follow.
    pub async fn lead_page(&self, after: Option<CatalogCursor>, filter: LeadFilter, limit: usize) -> Result<LeadPage, DbError> {
        self.read(move |c| {
            let mut stmt = c.prepare_cached(SCAN_SQL)?;
            let mut position = after;
            let mut rows = Vec::new();
            loop {
                let batch: Vec<(String, f64, String, bool)> = stmt
                    .query_map(
                        params![position.as_ref().map(|p| p.activity), position.as_ref().map(|p| p.id.clone()), SCAN_BATCH as i64],
                        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
                    )?
                    .collect::<Result<_, _>>()?;
                let scanned = batch.len();
                for (summary, activity, id, archived) in batch {
                    position = Some(CatalogCursor { activity, id });
                    let row = match serde_json::from_str::<Value>(&summary) {
                        Ok(Value::Object(row)) => row,
                        _ => {
                            return Err(DbError::Sqlite(rusqlite::Error::InvalidColumnType(
                                0,
                                "summary".into(),
                                rusqlite::types::Type::Text,
                            )));
                        }
                    };
                    let listed = LeadRow { row, archived };
                    if is_lead_visible_row(&listed.row) && filter.keeps(&listed) {
                        rows.push(listed);
                        if rows.len() > limit {
                            rows.truncate(limit);
                            return Ok(LeadPage { rows, more: true });
                        }
                    }
                }
                if scanned < SCAN_BATCH {
                    return Ok(LeadPage { rows, more: false });
                }
            }
        })
        .await
    }
}
