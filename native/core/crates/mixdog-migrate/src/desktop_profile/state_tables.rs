//! `desktop-projects.json` → `state/core.sqlite` `projects`, `agent-rooms.json` →
//! `rooms` (FORMAT.md §8.3). Rows are published in one transaction together with the
//! `migration:<item key>` meta row that makes the publication recognizable (§10.4).

use std::path::Path;

use mixdog_store::schema::bounded::Digest;
use mixdog_store::schema::migration::ManifestItem;
use mixdog_store::schema::migration::QuarantineCode;
use mixdog_store::schema::migration::StateTable;
use mixdog_store::schema::sql::STATE_DDL;
use rusqlite::Connection;
use rusqlite::TransactionBehavior;
use rusqlite::params;
use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;

use super::Staged;
use super::error::ApplyError;
use super::error::Step;
use super::fsx;
use super::jsvalue;
use super::source;
use super::source::Parsed;
use crate::durable;
use crate::framework::ItemContext;
use crate::json::utf16_len;

const ROWS_FILE: &str = "rows.json";
const MAX_HIDDEN_PATHS: usize = 50;
const MAX_ALIASES: usize = 200;
const MAX_ALIAS_LEN: usize = 120;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectRow {
    pub path: String,
    pub alias: Option<String>,
    pub hidden: bool,
    pub hidden_rank: Option<i64>,
    pub last_used_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RoomRow {
    pub room_id: String,
    /// The stored room document.
    pub doc: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "table", content = "rows", rename_all = "snake_case")]
pub enum Rows {
    Projects(Vec<ProjectRow>),
    Rooms(Vec<RoomRow>),
}

fn schema_violation(detail: &str) -> ApplyError {
    ApplyError::quarantine(QuarantineCode::SchemaViolation, detail)
}

/// `readProjectPreferences`: aliases and hidden paths clamped as the desktop clamps them.
pub fn project_rows(value: &Value) -> Result<Vec<ProjectRow>, ApplyError> {
    let root = jsvalue::object(value).ok_or_else(|| schema_violation("project preferences are not an object"))?;
    let mut rows = std::collections::BTreeMap::<String, ProjectRow>::new();
    let aliases = root.get("aliases").and_then(jsvalue::object).into_iter().flatten();
    let aliases = aliases
        .filter_map(|(path, alias)| {
            let alias = alias.as_str()?;
            (!path.is_empty() && utf16_len(alias) <= MAX_ALIAS_LEN).then_some((path, alias))
        })
        .take(MAX_ALIASES);
    for (path, alias) in aliases {
        rows.insert(
            path.clone(),
            ProjectRow {
                path: path.clone(),
                alias: Some(alias.to_owned()),
                hidden: false,
                hidden_rank: None,
                last_used_at: None,
            },
        );
    }
    let hidden = root.get("hidden").and_then(Value::as_array).into_iter().flatten();
    let hidden = hidden
        .filter_map(Value::as_str)
        .filter(|path| !path.is_empty())
        .take(MAX_HIDDEN_PATHS);
    let mut rank = 0i64;
    for path in hidden {
        let row = rows.entry(path.to_owned()).or_insert_with(|| ProjectRow {
            path: path.to_owned(),
            alias: None,
            hidden: false,
            hidden_rank: None,
            last_used_at: None,
        });
        if !row.hidden {
            row.hidden = true;
            row.hidden_rank = Some(rank);
            rank += 1;
        }
    }
    Ok(rows.into_values().collect())
}

/// `roomDocOf`: the room records, a round that was in flight marked interrupted (never
/// resumed): its `running` marker is cleared.
pub fn room_rows(value: &Value) -> Result<Vec<RoomRow>, ApplyError> {
    let root = jsvalue::object(value).ok_or_else(|| schema_violation("room records are not an object"))?;
    let Some(rooms) = root.get("rooms").and_then(jsvalue::object) else {
        return Ok(Vec::new());
    };
    let mut rows = Vec::with_capacity(rooms.len());
    for (room_id, record) in rooms {
        let mut doc = record
            .as_object()
            .cloned()
            .ok_or_else(|| schema_violation("a room record is not an object"))?;
        if doc.get("running").is_some_and(|running| !running.is_null()) {
            doc.insert("running".into(), Value::Null);
        }
        rows.push(RoomRow {
            room_id: room_id.clone(),
            doc: Value::Object(doc),
        });
    }
    rows.sort_by(|a, b| a.room_id.cmp(&b.room_id));
    Ok(rows)
}

fn convert(table: StateTable, value: &Value) -> Result<Rows, ApplyError> {
    match table {
        StateTable::Projects => project_rows(value).map(Rows::Projects),
        StateTable::Rooms => room_rows(value).map(Rows::Rooms),
    }
}

fn source_rows(cx: &ItemContext<'_>, item: &ManifestItem, table: StateTable) -> Step<(Rows, u64)> {
    let bytes = source::read_source(cx, super::single_source(item)?)?;
    let Parsed {
        value,
        replaced_surrogates,
    } = source::parse_json(&bytes)?;
    Ok((convert(table, &value)?, replaced_surrogates))
}

pub(super) fn stage(cx: &ItemContext<'_>, item: &ManifestItem, table: StateTable) -> Step<Staged> {
    let (rows, replaced_surrogates) = source_rows(cx, item, table)?;
    let bytes = source::canonical_text(&serde_json::to_value(&rows).expect("rows serialize")).into_bytes();
    let path = cx.stage_dir(item.key.as_str()).join(ROWS_FILE);
    fsx::write_new(&path, &bytes, false).map_err(|error| ApplyError::io("write", &path, error))?;
    Ok(Staged {
        output_sha256: durable::sha256_hex(&bytes),
        replaced_surrogates,
    })
}

fn state_path(data: &Path) -> std::path::PathBuf {
    data.join("state").join("core.sqlite")
}

fn open_state(data: &Path) -> Result<Connection, ApplyError> {
    let path = state_path(data);
    let blocked = |error: rusqlite::Error| ApplyError::blocked("sqlite", &path, error);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| ApplyError::io("create_dir", parent, error))?;
    }
    let connection = Connection::open(&path).map_err(blocked)?;
    let version: i64 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(blocked)?;
    if version == 0 {
        connection.execute_batch(STATE_DDL).map_err(blocked)?;
    }
    connection
        .query_row("PRAGMA journal_mode = WAL", [], |_| Ok(()))
        .map_err(blocked)?;
    connection.pragma_update(None, "synchronous", "FULL").map_err(blocked)?;
    Ok(connection)
}

fn meta_key(item: &ManifestItem) -> String {
    format!("migration:{}", item.key.as_str())
}

/// Inserts the staged rows and the item's meta row in one transaction; a no-op when the
/// meta row already names this manifest (a crash after the commit).
pub(super) fn publish(cx: &ItemContext<'_>, item: &ManifestItem) -> Step<()> {
    let (data, manifest_sha256) = (cx.roots.data.as_path(), cx.manifest_sha256);
    let staged = cx.stage_dir(item.key.as_str()).join(ROWS_FILE);
    let bytes = durable::read(&staged)?;
    let rows: Rows = serde_json::from_slice(&bytes)
        .map_err(|error| ApplyError::blocked("read", &staged, error))?;
    let path = state_path(data);
    let blocked = |error: rusqlite::Error| ApplyError::blocked("sqlite", &path, error);
    let mut connection = open_state(data)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(blocked)?;
    let key = meta_key(item);
    let published: Option<String> = transaction
        .query_row("SELECT value FROM meta WHERE key = ?1", [&key], |row| row.get(0))
        .map(Some)
        .or_else(|error| match error {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other),
        })
        .map_err(blocked)?;
    if published.as_deref() == Some(manifest_sha256) {
        return Ok(());
    }
    match &rows {
        Rows::Projects(rows) => {
            let mut insert = transaction
                .prepare(
                    "INSERT OR REPLACE INTO projects (path, alias, hidden, hidden_rank, last_used_at) \
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                )
                .map_err(blocked)?;
            for row in rows {
                insert
                    .execute(params![row.path, row.alias, row.hidden, row.hidden_rank, row.last_used_at])
                    .map_err(blocked)?;
            }
        }
        Rows::Rooms(rows) => {
            let mut insert = transaction
                .prepare("INSERT OR REPLACE INTO rooms (room_id, doc) VALUES (?1, ?2)")
                .map_err(blocked)?;
            for row in rows {
                insert
                    .execute(params![row.room_id, source::canonical_text(&row.doc)])
                    .map_err(blocked)?;
            }
        }
    }
    transaction
        .execute(
            "INSERT OR REPLACE INTO meta (key, value) VALUES (?1, ?2)",
            params![key, manifest_sha256],
        )
        .map_err(blocked)?;
    transaction.commit().map_err(blocked)
}

/// Writes `meta` rows in one transaction (idempotent).
pub(super) fn put_meta(cx: &ItemContext<'_>, rows: &[(String, String)]) -> Step<()> {
    let path = state_path(&cx.roots.data);
    let blocked = |error: rusqlite::Error| ApplyError::blocked("sqlite", &path, error);
    let mut connection = open_state(&cx.roots.data)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(blocked)?;
    for (key, value) in rows {
        transaction
            .execute("INSERT OR REPLACE INTO meta (key, value) VALUES (?1, ?2)", params![key, value])
            .map_err(blocked)?;
    }
    transaction.commit().map_err(blocked)
}

pub(super) fn get_meta(cx: &ItemContext<'_>, key: &str) -> Step<Option<String>> {
    let path = state_path(&cx.roots.data);
    open_state(&cx.roots.data)?
        .query_row("SELECT value FROM meta WHERE key = ?1", [key], |row| row.get(0))
        .map(Some)
        .or_else(|error| match error {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            other => Err(other),
        })
        .map_err(|error| ApplyError::blocked("sqlite", &path, error))
}

pub(super) fn delete_meta(cx: &ItemContext<'_>, keys: &[String]) -> Step<()> {
    let path = state_path(&cx.roots.data);
    let connection = open_state(&cx.roots.data)?;
    for key in keys {
        connection
            .execute("DELETE FROM meta WHERE key = ?1", [key])
            .map_err(|error| ApplyError::blocked("sqlite", &path, error))?;
    }
    Ok(())
}

/// Deletes the rows `publish` inserted and the item's meta row, before the source is
/// quarantined.
pub(super) fn withdraw(cx: &ItemContext<'_>, item: &ManifestItem) -> Step<()> {
    let staged = cx.stage_dir(item.key.as_str()).join(ROWS_FILE);
    let rows: Option<Rows> = match durable::read_optional(&staged)? {
        Some(bytes) => Some(
            serde_json::from_slice(&bytes).map_err(|error| ApplyError::blocked("read", &staged, error))?,
        ),
        None => None,
    };
    let path = state_path(&cx.roots.data);
    let blocked = |error: rusqlite::Error| ApplyError::blocked("sqlite", &path, error);
    let mut connection = open_state(&cx.roots.data)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(blocked)?;
    match rows {
        Some(Rows::Projects(rows)) => {
            for row in rows {
                transaction.execute("DELETE FROM projects WHERE path = ?1", [row.path]).map_err(blocked)?;
            }
        }
        Some(Rows::Rooms(rows)) => {
            for row in rows {
                transaction.execute("DELETE FROM rooms WHERE room_id = ?1", [row.room_id]).map_err(blocked)?;
            }
        }
        None => {}
    }
    transaction.execute("DELETE FROM meta WHERE key = ?1", [meta_key(item)]).map_err(blocked)?;
    transaction.commit().map_err(blocked)
}

fn target_rows(data: &Path, table: StateTable) -> Result<Rows, ApplyError> {
    let path = state_path(data);
    let blocked = |error: rusqlite::Error| ApplyError::blocked("sqlite", &path, error);
    let connection = open_state(data)?;
    match table {
        StateTable::Projects => {
            let mut select = connection
                .prepare("SELECT path, alias, hidden, hidden_rank, last_used_at FROM projects ORDER BY path")
                .map_err(blocked)?;
            let rows = select
                .query_map([], |row| {
                    Ok(ProjectRow {
                        path: row.get(0)?,
                        alias: row.get(1)?,
                        hidden: row.get(2)?,
                        hidden_rank: row.get(3)?,
                        last_used_at: row.get(4)?,
                    })
                })
                .and_then(|rows| rows.collect::<Result<Vec<_>, _>>())
                .map_err(blocked)?;
            Ok(Rows::Projects(rows))
        }
        StateTable::Rooms => {
            let mut select = connection
                .prepare("SELECT room_id, doc FROM rooms ORDER BY room_id")
                .map_err(blocked)?;
            let rows = select
                .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
                .and_then(|rows| rows.collect::<Result<Vec<_>, _>>())
                .map_err(blocked)?;
            let rows = rows
                .into_iter()
                .map(|(room_id, doc)| {
                    serde_json::from_str(&doc)
                        .map(|doc| RoomRow { room_id, doc })
                        .map_err(|_| ApplyError::quarantine(QuarantineCode::DigestMismatch, "room document is not JSON"))
                })
                .collect::<Result<Vec<_>, _>>()?;
            Ok(Rows::Rooms(rows))
        }
    }
}

/// The source rows (read afresh) must equal the rows the database holds, and the meta
/// row must name this manifest. The whole table is compared: the migration runs before
/// the runtime serves, so nothing else has written to it.
pub(super) fn verify(cx: &ItemContext<'_>, item: &ManifestItem, table: StateTable) -> Step<Digest> {
    let (data, manifest_sha256) = (cx.roots.data.as_path(), cx.manifest_sha256);
    let (expected, _) = source_rows(cx, item, table)?;
    let observed = target_rows(data, table)?;
    let published: String = open_state(data)?
        .query_row("SELECT value FROM meta WHERE key = ?1", [meta_key(item)], |row| row.get(0))
        .map_err(|error| ApplyError::blocked("sqlite", &state_path(data), error))?;
    let mismatch = |detail: &str| ApplyError::quarantine(QuarantineCode::DigestMismatch, detail);
    if published != manifest_sha256 {
        return Err(mismatch("the meta row names another manifest"));
    }
    let expected = serde_json::to_value(&expected).expect("rows serialize");
    let observed = serde_json::to_value(&observed).expect("rows serialize");
    if source::canonical_text(&expected) != source::canonical_text(&observed) {
        return Err(mismatch("the table rows differ from the source"));
    }
    Ok(source::digest_value(&expected))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn json(text: &str) -> Value {
        serde_json::from_str(text).unwrap()
    }

    #[test]
    fn projects_keep_aliases_and_the_hidden_order() {
        let rows = project_rows(&json(
            r#"{"version":2,"aliases":{"C:/b":"B","C:/a":"A","":"x","C:/long":3},
                "hidden":["C:/z","C:/a","C:/z",""]}"#,
        ))
        .unwrap();
        let summary: Vec<_> = rows
            .iter()
            .map(|row| (row.path.as_str(), row.alias.as_deref(), row.hidden, row.hidden_rank))
            .collect();
        assert_eq!(
            summary,
            [
                ("C:/a", Some("A"), true, Some(1)),
                ("C:/b", Some("B"), false, None),
                ("C:/z", None, true, Some(0)),
            ]
        );
    }

    #[test]
    fn a_running_round_is_cleared_and_other_fields_stay() {
        let rows = room_rows(&json(
            r#"{"rooms":{"r2":{"id":"r2","running":{"startedAt":5},"lastPreview":"hi"},"r1":{"id":"r1","running":null}}}"#,
        ))
        .unwrap();
        assert_eq!(rows[0].room_id, "r1");
        assert_eq!(rows[1].doc["running"], Value::Null);
        assert_eq!(rows[1].doc["lastPreview"], "hi");
    }

    #[test]
    fn a_document_that_is_not_an_object_is_a_schema_violation() {
        for text in ["[]", "3"] {
            let Err(ApplyError::Quarantine(failure)) = project_rows(&json(text)) else {
                panic!("expected quarantine");
            };
            assert_eq!(failure.code, QuarantineCode::SchemaViolation);
        }
        assert!(room_rows(&json(r#"{"rooms":{"r":3}}"#)).is_err());
        assert!(room_rows(&json("{}")).unwrap().is_empty());
    }
}
