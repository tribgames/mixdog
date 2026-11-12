//! What the earlier version listed of its sessions: the rows of its catalog database (`session-catalog.sqlite`), a cache it
//! derived from the session files and listed from (`catalog-db/schema.mjs`). A core that serves while the sessions convert
//! lists each session by its row here until the session itself is there, so the list is whole from the first start.
//!
//! The file is read as it lies, immutably: it is a source the migration retires, and nothing of it may change. It is a
//! cache, so whatever it does not answer (no file, another layout, a row that does not decode) lists nothing, and that
//! session appears when it is converted.

#![allow(
    clippy::disallowed_types,
    reason = "one-time migration: the earlier version's catalog database read directly on the migration thread"
)]

use std::path::Path;

use rusqlite::Connection;
use rusqlite::OpenFlags;
use rusqlite::types::ValueRef;
use serde_json::Map;
use serde_json::Number;
use serde_json::Value;

pub const CATALOG_FILE: &str = "session-catalog.sqlite";

/// How a column holds its row key (`FIELDS` of `schema.mjs`).
#[derive(Clone, Copy)]
enum Codec {
    /// A number, a string or null as bound; anything else as a JSON blob.
    Loose,
    Bool,
    /// An object or null, as JSON text.
    Json,
    /// [`Codec::Json`], the key absent when null.
    OptJson,
}

/// `[row key, column, codec]`: every field of a listed row (the storage stamp is the cache's own).
const FIELDS: [(&str, &str, Codec); 36] = [
    ("id", "id", Codec::Loose),
    ("updatedAt", "updated_at", Codec::Loose),
    ("lastUsedAt", "last_used_at", Codec::Loose),
    ("createdAt", "created_at", Codec::Loose),
    ("lastHeartbeatAt", "last_heartbeat_at", Codec::Loose),
    ("closed", "closed", Codec::Bool),
    ("status", "status", Codec::Loose),
    ("owner", "owner", Codec::Loose),
    ("agent", "agent", Codec::Loose),
    ("sourceType", "source_type", Codec::Loose),
    ("sourceName", "source_name", Codec::Loose),
    ("scopeKey", "scope_key", Codec::Loose),
    ("ownerSessionId", "owner_session_id", Codec::Loose),
    ("visibility", "visibility", Codec::Loose),
    ("clientHostPid", "client_host_pid", Codec::Loose),
    ("cwd", "cwd", Codec::Loose),
    ("desktopSession", "desktop_session", Codec::Json),
    ("workspace", "workspace", Codec::OptJson),
    ("provider", "provider", Codec::Loose),
    ("model", "model", Codec::Loose),
    ("agentTag", "agent_tag", Codec::Loose),
    ("task_id", "task_id", Codec::Loose),
    ("permission", "permission", Codec::Loose),
    ("toolPermission", "tool_permission", Codec::Loose),
    ("messageCount", "message_count", Codec::Loose),
    ("title", "title", Codec::Loose),
    ("preview", "preview", Codec::Loose),
    ("generation", "generation", Codec::Loose),
    ("detachedReason", "detached_reason", Codec::Loose),
    ("inheritedFromSessionId", "inherited_from_session_id", Codec::Loose),
    ("realTurnCount", "real_turn_count", Codec::Loose),
    ("lastMessagePreview", "last_message_preview", Codec::Loose),
    ("lastMessageRoutine", "last_message_routine", Codec::Json),
    ("sessionMode", "session_mode", Codec::Loose),
    ("incomingTail", "incoming_tail", Codec::OptJson),
    ("compactCount", "compact_count", Codec::OptJson),
];

fn decode(value: ValueRef<'_>, codec: Codec) -> Option<Value> {
    let json = |bytes: &[u8]| serde_json::from_slice::<Value>(bytes).ok();
    Some(match (codec, value) {
        (Codec::OptJson, ValueRef::Null) => return None,
        (_, ValueRef::Null) => Value::Null,
        (Codec::Bool, ValueRef::Integer(n)) => Value::Bool(n != 0),
        (Codec::Json | Codec::OptJson, ValueRef::Text(text)) => json(text)?,
        (_, ValueRef::Integer(n)) => Value::Number(n.into()),
        (_, ValueRef::Real(n)) => Value::Number(Number::from_f64(n)?),
        (_, ValueRef::Text(text)) => Value::String(String::from_utf8(text.to_vec()).ok()?),
        (_, ValueRef::Blob(bytes)) => json(bytes)?,
    })
}

/// An immutable read-only URI of `path`: no lock, no journal file made beside it.
fn immutable(path: &Path) -> String {
    let escaped = path.to_string_lossy().replace('\\', "/").replace('%', "%25").replace('?', "%3f").replace('#', "%23");
    format!("file:{}{escaped}?immutable=1", if escaped.starts_with('/') { "" } else { "/" })
}

fn read(path: &Path) -> rusqlite::Result<Vec<(String, Map<String, Value>)>> {
    let conn = Connection::open_with_flags(immutable(path), OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI)?;
    let columns = FIELDS.iter().map(|(_, column, _)| *column).collect::<Vec<_>>().join(", ");
    let mut stmt = conn.prepare(&format!("SELECT {columns} FROM sessions"))?;
    let mut rows = stmt.query([])?;
    let mut listed = Vec::new();
    while let Some(found) = rows.next()? {
        let mut row = Map::new();
        for (at, (key, _, codec)) in FIELDS.iter().enumerate() {
            if let Some(value) = decode(found.get_ref(at)?, *codec) {
                row.insert((*key).to_owned(), value);
            }
        }
        if let Some(id) = row.get("id").and_then(Value::as_str).filter(|id| super::source::is_session_id(id)) {
            listed.push((id.to_owned(), row));
        }
    }
    Ok(listed)
}

/// The rows the earlier version listed, `(session id, row)`; none when its catalog does not answer.
pub fn rows(data: &Path) -> Vec<(String, Map<String, Value>)> {
    let path = data.join(CATALOG_FILE);
    if !crate::durable::is_file(&path) {
        return Vec::new();
    }
    read(&path).unwrap_or_default()
}
